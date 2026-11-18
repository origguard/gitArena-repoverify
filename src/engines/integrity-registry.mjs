import { generateKeyPairSync, createPublicKey, sign, verify, createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getDb } from '../db/database.mjs';
import { inspectRepository } from './repo-service.mjs';
import { getScannerRepoId } from '../config/flags.mjs';
import {
  Evidence,
  Verdict,
  ALLOW_FLOOR,
  SCOPE_NOTICE,
  ASSURANCE_LIMITATIONS,
  canonicalJson,
  decide,
  isSignable,
  evaluatePolicyAction
} from './evidence.mjs';
import { revokeKeyId, isKeyRevoked } from './revocation.mjs';
import { assessCoverage, gateCompleteness, applyCap, decomposeReasons } from './completeness.mjs';
import { buildIdentityScope } from './identity-anchor.mjs';

/**
 * Registre de Signatures d'Intégrité Ed25519 — Pilier 2 (RepoVerify / GitArena)
 * Produit des signatures d'intégrité horodatées localement, adossées au modèle de preuve fail-closed.
 * Ne produit JAMAIS d'ALLOW sans preuve vérifiable ni d'attestation sur clé révoquée.
 * 100 % Natif Node.js ESM, zéro dépendance NPM.
 */

let cachedKeys = null;

function resolveExternalKeyPath(customPath = null) {
  const raw = customPath || process.env.REPOVERIFY_SIGNING_KEY_PATH || join(homedir(), '.repoverify', 'keys', 'signing-ed25519.private.pem');
  const resolved = resolve(raw);
  const cwdResolved = resolve(process.cwd());
  if (resolved.toLowerCase().startsWith(cwdResolved.toLowerCase())) {
    throw new Error(`Refus de custody : la clé privée ne doit jamais résider dans le dépôt (${resolved})`);
  }
  return resolved;
}

export function computeKeyId(publicKeyPem) {
  const pubKeyObj = createPublicKey(publicKeyPem);
  const spkiDer = pubKeyObj.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
}

export function getOrInitSigningKeys(customPath = null) {
  if (cachedKeys && !customPath) return cachedKeys;

  const privPath = resolveExternalKeyPath(customPath);
  const pubPath = privPath.replace(/\.private\.pem$/i, '.public.pem');

  if (existsSync(privPath) && existsSync(pubPath)) {
    const privateKeyPem = readFileSync(privPath, 'utf8');
    const publicKeyPem = readFileSync(pubPath, 'utf8');
    const keyid = computeKeyId(publicKeyPem);
    cachedKeys = { privateKeyPem, publicKeyPem, keyid, keyPath: privPath };
    return cachedKeys;
  }

  mkdirSync(dirname(privPath), { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  writeFileSync(privPath, privateKey, { mode: 0o600 });
  try { chmodSync(privPath, 0o600); } catch { /* Windows NTFS ignores POSIX mode */ }
  writeFileSync(pubPath, publicKey, 'utf8');

  const keyid = computeKeyId(publicKey);
  cachedKeys = { privateKeyPem: privateKey, publicKeyPem: publicKey, keyid, keyPath: privPath };
  return cachedKeys;
}

export function rotateSigningKey(reason = 'manual_key_rotation', customPath = null) {
  const current = getOrInitSigningKeys(customPath);
  const oldKeyid = current.keyid;
  const privPath = resolveExternalKeyPath(customPath);
  const pubPath = privPath.replace(/\.private\.pem$/i, '.public.pem');

  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  mkdirSync(dirname(privPath), { recursive: true, mode: 0o700 });
  writeFileSync(privPath, privateKey, { mode: 0o600 });
  try { chmodSync(privPath, 0o600); } catch { /* ignore */ }
  writeFileSync(pubPath, publicKey, 'utf8');

  const newKeyid = computeKeyId(publicKey);
  if (oldKeyid !== newKeyid) {
    revokeKeyId(oldKeyid, reason, newKeyid);
  }

  cachedKeys = { privateKeyPem: privateKey, publicKeyPem: publicKey, keyid: newKeyid, keyPath: privPath };
  return { oldKeyid, newKeyid, reason, keyPath: privPath };
}

export function getPublicKeyInfo() {
  const { publicKeyPem, keyid } = getOrInitSigningKeys();
  const keyFingerprint = createHash('sha256').update(publicKeyPem).digest('hex');
  return {
    algorithm: 'Ed25519',
    keyid,
    keyFingerprint,
    publicKeyPem,
    custody: 'external_keystore'
  };
}

/**
 * Lit UNIQUEMENT les faits comportementaux persistés (sans verdict précalculé).
 * En cas d'absence du cache, ne retourne JAMAIS de valeur par défaut positive.
 */
export function getCachedBehaviorOrAnalyze(ownerOrFullName, maybeName = null) {
  let owner = ownerOrFullName;
  let name = maybeName;
  if (!name && String(ownerOrFullName).includes('/')) {
    const parts = String(ownerOrFullName).split('/');
    owner = parts[0];
    name = parts[1];
  }

  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT id, scan_mode, scan_scope, ref, findings_json, scanned_at
      FROM behavioral_facts
      WHERE owner = ? AND name = ?
      ORDER BY scanned_at DESC, id DESC
      LIMIT 1
    `).get(String(owner || ''), String(name || ''));

    if (!row) {
      return { scanMode: null, scanScope: null, findings: null, ref: null, scannedAt: null };
    }
    return {
      scanMode: row.scan_mode,
      scanScope: row.scan_scope || null,
      findings: row.findings_json ? JSON.parse(row.findings_json) : null,
      ref: row.ref || `behavioral_facts:${row.id}`,
      scannedAt: row.scanned_at
    };
  } catch {
    return { scanMode: null, scanScope: null, findings: null, ref: null, scannedAt: null };
  }
}

export function recordBehavioralFacts({ owner, name, fullName, commitSha = null, scanMode = 'STATIC', scanScope = null, findings = [], scannerVersion = '1.0.0' }) {
  const db = getDb();
  const res = db.prepare(`
    INSERT INTO behavioral_facts (
      owner, name, full_name, commit_sha, scan_mode, scan_scope, findings_json, scanned_at, scanner_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    owner,
    name,
    fullName || `${owner}/${name}`,
    commitSha,
    scanMode,
    scanScope,
    JSON.stringify(findings || []),
    new Date().toISOString(),
    scannerVersion
  );
  const id = Number(res.lastInsertRowid);
  const ref = `behavioral_facts:${id}`;
  db.prepare('UPDATE behavioral_facts SET ref = ? WHERE id = ?').run(ref, id);
  return {
    id,
    scanMode,
    scanScope,
    findings: findings || [],
    ref
  };
}

function getCachedOsvSummary(fullName) {
  try {
    const db = getDb();
    const osvRow = db.prepare(`
      SELECT ref, vulns_json, status, deps_declared, deps_resolved, deps_queried, COALESCE(deps_answered, 0) AS deps_answered, lockfile_used, coverage_gate
      FROM osv_queries
      WHERE full_name = ? AND status = 'queried'
      ORDER BY queried_at DESC, id DESC
      LIMIT 1
    `).get(fullName);

    if (osvRow) {
      const vulns = JSON.parse(osvRow.vulns_json || '[]');
      const cov = assessCoverage({
        lockfile: osvRow.lockfile_used || null,
        deps_declared: osvRow.deps_declared,
        deps_resolved: osvRow.deps_resolved,
        deps_queried: osvRow.deps_queried ?? 0,
        deps_answered: osvRow.deps_answered ?? 0,
        transitive: Boolean(osvRow.lockfile_used),
      });
      const gateRes = gateCompleteness(cov);
      return {
        scanned: true,
        vulns,
        totalVulnerabilities: vulns.length,
        maxSeverity: vulns.length > 0 ? 'HIGH' : 'NONE',
        ref: osvRow.ref,
        coverage: cov,
        coverageGate: gateRes.gate,
        coverageCap: gateRes.cap,
        lockfileUsed: osvRow.lockfile_used || null,
        depsAnswered: cov.deps_answered,
      };
    }

    const gRow = db.prepare('SELECT dependencies_json FROM gitingest_cache WHERE full_name = ?').get(fullName);
    if (!gRow) return { scanned: false, totalVulnerabilities: 0, maxSeverity: 'NONE', ref: null };
    const deps = JSON.parse(gRow.dependencies_json || '{}');
    const runtime = Array.isArray(deps.runtime) ? deps.runtime.slice(0, 25) : [];
    if (runtime.length === 0) return { scanned: false, totalVulnerabilities: 0, maxSeverity: 'NONE', ref: null };

    const placeholders = runtime.map(() => '?').join(',');
    const rows = db.prepare(`SELECT package_name, vuln_count, max_severity FROM osv_vuln_cache WHERE package_name IN (${placeholders})`).all(...runtime);
    if (rows.length === 0) return { scanned: false, totalVulnerabilities: 0, maxSeverity: 'NONE', ref: null };

    let total = 0;
    let maxSev = 'NONE';
    const rank = { CRITICAL: 4, HIGH: 3, MODERATE: 2, LOW: 1, NONE: 0 };
    for (const r of rows) {
      total += r.vuln_count || 0;
      if ((rank[r.max_severity] || 0) > (rank[maxSev] || 0)) maxSev = r.max_severity;
    }
    return {
      scanned: true,
      totalVulnerabilities: total,
      maxSeverity: maxSev,
      ref: `osv_vuln_cache:${rows[0].package_name}`
    };
  } catch {
    return { scanned: false, totalVulnerabilities: 0, maxSeverity: 'NONE', ref: null };
  }
}

/**
 * Évalue un dépôt selon le modèle de preuve fail-closed + les portes d'entreprise.
 */
export function evaluateGatekeeperPolicy(inspectPayload, behaviorFacts, osvSummary, policyProfile = 'enterprise', execution = null) {
  const { repository: repo, health, legalAndSecurity: legal } = inspectPayload;
  const ev = decide({ behavioral: behaviorFacts, osv: osvSummary, execution }, ALLOW_FLOOR);

  const violations = [];
  const warnings = [];
  let trustScore = 100;

  // Porte 1 : Licence commerciale
  if (!legal.commercialSafe) {
    if (policyProfile === 'strict' || policyProfile === 'enterprise') {
      violations.push({ gate: 'LICENSE_COMPLIANCE', severity: 'BLOCKER', message: `Licence ${legal.licenseSpdx} non permissive (risque copyleft).` });
      trustScore -= 35;
    } else {
      warnings.push({ gate: 'LICENSE_COMPLIANCE', severity: 'WARN', message: `Licence ${legal.licenseSpdx} à vérifier juridiquement.` });
      trustScore -= 15;
    }
  }

  // Porte 2 : Fraîcheur & CI/CD
  if (health.daysSinceLastPush > 180) {
    violations.push({ gate: 'MAINTENANCE_ACTIVITY', severity: 'BLOCKER', message: `Dépôt inactif depuis ${health.daysSinceLastPush} jours (> 180j).` });
    trustScore -= 25;
  }
  if (health.ciTelemetry?.available && health.ciTelemetry.lastRunStatus === 'FAILURE') {
    if (policyProfile === 'strict') {
      violations.push({ gate: 'CI_BUILD_HEALTH', severity: 'BLOCKER', message: 'Dernier workflow GitHub Actions en échec (FAILURE).' });
      trustScore -= 20;
    } else {
      warnings.push({ gate: 'CI_BUILD_HEALTH', severity: 'WARN', message: 'Dernier workflow GitHub Actions en échec.' });
      trustScore -= 10;
    }
  }

  // Porte 3 : Bus Factor
  if (health.maintainerHealth?.available && health.maintainerHealth.busFactorRisk === 'HIGH') {
    if (policyProfile === 'strict') {
      violations.push({ gate: 'BUS_FACTOR_RISK', severity: 'BLOCKER', message: `Risque mono-mainteneur élevé (${health.maintainerHealth.topContributorShare}% par 1 contributeur).` });
      trustScore -= 20;
    } else {
      warnings.push({ gate: 'BUS_FACTOR_RISK', severity: 'WARN', message: `Bus Factor élevé (top contributeur ${health.maintainerHealth.topContributorShare}%).` });
      trustScore -= 10;
    }
  }

  // Porte 4 & 5 : Preuves OSV + Analyse comportementale
  if (ev.verdict === Verdict.DENY) {
    for (const r of ev.reasons) {
      violations.push({ gate: 'EVIDENCE_DENY', severity: 'BLOCKER', message: `Signal critique observé : ${r}` });
    }
    trustScore -= 45;
  } else if (ev.verdict === Verdict.INDETERMINATE) {
    warnings.push({ gate: 'EVIDENCE_FLOOR', severity: 'WARN', message: `Preuves insuffisantes (${ev.evidenceName}, manquant: ${ev.missing.join(', ') || 'osv_query'}).` });
    trustScore = Math.min(trustScore, 50);
  } else if (ev.verdict === Verdict.WARN) {
    warnings.push({ gate: 'BEHAVIORAL_SIGNALS', severity: 'WARN', message: `${ev.reasons.length} signal(s) à examiner.` });
    trustScore -= 10;
  }

  trustScore = Math.max(0, Math.min(100, trustScore));

  let decision;
  if (violations.length > 0 || ev.verdict === Verdict.DENY) {
    decision = Verdict.DENY;
  } else if (ev.verdict === Verdict.INDETERMINATE) {
    decision = Verdict.INDETERMINATE;
  } else if (warnings.length > 0 || ev.verdict === Verdict.WARN) {
    decision = Verdict.WARN;
  } else {
    decision = Verdict.ALLOW;
  }

  // I6 : Plafonnement strict par la complétude OSV (lockfile + >= 98 % des dépendances interrogées)
  if (osvSummary?.scanned) {
    const cap = osvSummary.coverageCap || (osvSummary.coverageGate === 'PASS' ? 'ALLOW' : 'INDETERMINATE');
    const cappedDecision = applyCap(decision, cap);
    if (cappedDecision !== decision) {
      warnings.push({
        gate: 'COMPLETENESS_GATE',
        severity: 'WARN',
        message: `Verdict plafonné de ${decision} à ${cappedDecision} par I6 (${osvSummary.coverageGate || 'NO_LOCKFILE'}).`
      });
      decision = cappedDecision;
    }
  }

  const policyAction = evaluatePolicyAction({ verdict: decision }, policyProfile);
  let identityMeta = null;
  try {
    const db = getDb();
    const rIdRow = db.prepare('SELECT identity_json FROM repos WHERE full_name = ?').get(repo.full_name);
    if (rIdRow?.identity_json) identityMeta = JSON.parse(rIdRow.identity_json);
  } catch { /* fallback if no repos row */ }
  const identityScope = buildIdentityScope(identityMeta, identityMeta?.anchor || null);

  return {
    decision,
    action: policyAction.action,
    trustScore,
    policyProfile,
    evidenceLevel: ev.evidenceLevel,
    evidenceName: ev.evidenceName,
    evidenceRefs: ev.evidenceRefs,
    missing: ev.missing,
    violations,
    warnings,
    summary: {
      fullName: repo.full_name,
      license: legal.licenseSpdx,
      commercialSafe: legal.commercialSafe,
      aiScore: repo.ai_potential_score,
      elo: repo.elo_rating,
      busFactorRisk: health.maintainerHealth?.busFactorRisk || 'UNKNOWN',
      scanMode: behaviorFacts?.scanMode || null,
      osvScanned: Boolean(osvSummary?.scanned),
      osvMaxSeverity: osvSummary?.maxSeverity || 'NONE',
      coverageGate: osvSummary?.coverageGate || (osvSummary?.scanned ? 'NO_LOCKFILE' : null),
      lockfileUsed: osvSummary?.lockfileUsed || null,
      assuranceScope: {
        identity: identityScope
      }
    }
  };
}

/**
 * Émet et signe (Ed25519) une signature d'intégrité dans integrity_signatures
 */
export async function issueIntegritySignature(owner, name, options = {}) {
  const policyProfile = options.policyProfile || 'enterprise';
  const insp = await inspectRepository(owner, name, {
    includeLiveCi: options.includeLiveCi !== false,
    persistHarness: false
  });
  if (!insp.ok) {
    return { ok: false, status: insp.status, error: insp.payload?.error || 'Dépôt introuvable' };
  }

  const repoRow = insp.payload.repository;
  const fullName = repoRow.full_name;
  const scannerRepoId = getScannerRepoId();
  if (scannerRepoId > 0 && Number(repoRow.id) === scannerRepoId) {
    return {
      ok: false,
      status: 403,
      error: 'auto_certification_forbidden: le scanner ne peut pas signer son propre dépôt'
    };
  }

  const behaviorFacts = options.behaviorFacts || getCachedBehaviorOrAnalyze(owner, name);
  const osvSummary = options.osvSummary || getCachedOsvSummary(fullName);
  const execution = options.execution || null;

  const evaluation = evaluateGatekeeperPolicy(insp.payload, behaviorFacts, osvSummary, policyProfile, execution);
  // Asymétrie fail-closed : un ALLOW sans evidenceRefs redevient INDETERMINATE, jamais DENY qui reste bloquant.
  if (evaluation.decision !== Verdict.DENY && !isSignable({ verdict: evaluation.decision, evidenceRefs: evaluation.evidenceRefs })) {
    evaluation.decision = Verdict.INDETERMINATE;
    evaluation.action = evaluatePolicyAction({ verdict: Verdict.INDETERMINATE }, policyProfile).action;
  }

  const { privateKeyPem, publicKeyPem, keyid } = getOrInitSigningKeys();
  const sigId = randomUUID();
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 90 * 86400000).toISOString();

  const payload = {
    schema: 'repoverify-integrity-signature/v2',
    documentType: 'signature_integrite_build',
    id: sigId,
    subjectRepoId: repoRow.id,
    keyid,
    issuedAt,
    expiresAt,
    scopeNotice: SCOPE_NOTICE,
    limitations: ASSURANCE_LIMITATIONS,
    ...evaluation
  };

  const payloadCanonical = canonicalJson(payload);
  const payloadSha256 = createHash('sha256').update(payloadCanonical, 'utf8').digest('hex');
  const signatureEd25519 = sign(null, Buffer.from(payloadCanonical, 'utf8'), privateKeyPem).toString('base64');

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO integrity_signatures (
        id, full_name, subject_repo_id, policy_profile, decision, trust_score,
        evidence_level, evidence_refs_json, keyid, expires_at,
        violations_json, payload_json, signature_ed25519, public_key_pem, payload_sha256, issued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sigId,
      fullName,
      repoRow.id,
      policyProfile,
      evaluation.decision,
      evaluation.trustScore,
      evaluation.evidenceLevel,
      JSON.stringify(evaluation.evidenceRefs),
      keyid,
      expiresAt,
      JSON.stringify(evaluation.violations),
      payloadCanonical,
      signatureEd25519,
      publicKeyPem,
      payloadSha256,
      issuedAt
    );
  } catch { /* ignore if DB unavailable */ }

  return {
    ok: true,
    signature: {
      id: sigId,
      documentType: 'signature_integrite_build',
      fullName,
      subjectRepoId: repoRow.id,
      keyid,
      decision: evaluation.decision,
      action: evaluation.action,
      trustScore: evaluation.trustScore,
      evidenceLevel: evaluation.evidenceLevel,
      evidenceName: evaluation.evidenceName,
      evidenceRefs: evaluation.evidenceRefs,
      missing: evaluation.missing,
      policyProfile,
      violations: evaluation.violations,
      warnings: evaluation.warnings,
      summary: evaluation.summary,
      scopeNotice: SCOPE_NOTICE,
      limitations: ASSURANCE_LIMITATIONS,
      payload,
      payloadJson: payloadCanonical,
      payloadSha256,
      signatureEd25519,
      publicKeyPem,
      issuedAt,
      expiresAt
    }
  };
}

/**
 * Vérifie hors-ligne l'authenticité cryptographique d'une signature d'intégrité (fail-closed)
 */
export function verifyIntegritySignature({ payloadJson, payload, signatureEd25519, publicKeyPem, payloadSha256, keyid, evidenceRefs, decision, verdict }) {
  try {
    const canonical = payloadJson || (payload ? canonicalJson(payload) : null);
    if (!canonical || !signatureEd25519 || !publicKeyPem) {
      return { valid: false, reason: 'Champs cryptographiques incomplets' };
    }

    const derivedKeyid = keyid || computeKeyId(publicKeyPem);
    if (!derivedKeyid) {
      return { valid: false, reason: 'keyid introuvable ou invalide' };
    }

    const revoked = isKeyRevoked(derivedKeyid);
    if (revoked) {
      return { valid: false, reason: `Clé révoquée (${derivedKeyid} : ${revoked.reason})` };
    }

    let parsedPayload = payload;
    if (!parsedPayload && payloadJson) {
      try { parsedPayload = JSON.parse(payloadJson); } catch { /* ignore */ }
    }
    const effectiveVerdict = decision || verdict || parsedPayload?.decision;
    const effectiveRefs = Array.isArray(evidenceRefs) ? evidenceRefs : parsedPayload?.evidenceRefs;
    if (effectiveVerdict === Verdict.ALLOW && (!Array.isArray(effectiveRefs) || effectiveRefs.length === 0)) {
      return { valid: false, reason: 'Invalide : verdict ALLOW sans référence de preuve (I5)' };
    }

    const computedHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
    if (payloadSha256 && computedHash !== payloadSha256) {
      return { valid: false, reason: 'Altération détectée : empreinte SHA-256 non conforme' };
    }

    const sigValid = verify(
      null,
      Buffer.from(canonical, 'utf8'),
      publicKeyPem,
      Buffer.from(signatureEd25519, 'base64')
    );

    return {
      valid: sigValid,
      keyid: derivedKeyid,
      computedSha256: computedHash,
      reason: sigValid ? 'Signature d\'intégrité Ed25519 authentique et non révoquée' : 'Signature Ed25519 invalide'
    };
  } catch (err) {
    return { valid: false, reason: `Erreur de vérification : ${err.message}` };
  }
}

export function getRecentIntegritySignatures(limit = 20) {
  try {
    const db = getDb();
    return db.prepare(`
      SELECT id, full_name, subject_repo_id, policy_profile, decision, trust_score,
             evidence_level, evidence_refs_json, keyid, expires_at,
             violations_json, payload_sha256, issued_at
      FROM integrity_signatures
      ORDER BY issued_at DESC
      LIMIT ?
    `).all(limit).map(r => ({
      ...r,
      evidenceRefs: JSON.parse(r.evidence_refs_json || '[]'),
      violations: JSON.parse(r.violations_json || '[]')
    }));
  } catch {
    return [];
  }
}

export function getHonestCensus() {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM repositories) AS indexed,
        (SELECT COUNT(*) FROM corpus_inputs) AS inputs,
        (SELECT COUNT(*) FROM corpus_inputs WHERE status != 'pending') AS attempted,
        (SELECT COUNT(*) FROM corpus_inputs WHERE status = 'pending') AS unattempted,
        (SELECT COUNT(*) FROM corpus_inputs WHERE status = 'ghost_404') AS ghosts,
        (SELECT COUNT(*) FROM corpus_inputs WHERE status = 'duplicate') AS duplicates,
        (SELECT COUNT(*) FROM repos) AS resolved,
        (SELECT COUNT(DISTINCT owner || '/' || name) FROM behavioral_facts WHERE scan_mode = 'STATIC' AND COALESCE(scan_scope, '') != 'no_manifest_found') AS static_scanned,
        (SELECT COUNT(DISTINCT owner || '/' || name) FROM osv_queries WHERE status = 'queried') AS osv_queried,
        (SELECT COUNT(*) FROM (
          SELECT b.owner, b.name
          FROM behavioral_facts b
          JOIN osv_queries o ON o.owner = b.owner AND o.name = b.name
          WHERE b.scan_mode = 'STATIC'
            AND COALESCE(b.scan_scope, '') != 'no_manifest_found'
            AND o.status = 'queried'
            AND COALESCE(o.coverage_gate, '') = 'PASS'
            AND json_array_length(b.findings_json) = 0
            AND json_array_length(o.vulns_json) = 0
          GROUP BY b.owner, b.name
        )) AS derived_verified,
        (SELECT COUNT(*) FROM integrity_signatures WHERE decision = 'ALLOW' AND evidence_level >= ?) AS signed_allow
    `).get(ALLOW_FLOOR);

    const passRows = db.prepare(`
      WITH latest_b AS (
        SELECT owner, name, full_name, findings_json,
               ROW_NUMBER() OVER (PARTITION BY owner, name ORDER BY scanned_at DESC, id DESC) AS rn
        FROM behavioral_facts
        WHERE scan_mode = 'STATIC' AND COALESCE(scan_scope, '') != 'no_manifest_found'
      ),
      latest_o AS (
        SELECT owner, name, full_name, vulns_json, status, coverage_gate,
               ROW_NUMBER() OVER (PARTITION BY owner, name ORDER BY queried_at DESC, id DESC) AS rn
        FROM osv_queries
      )
      SELECT json_array_length(b.findings_json) AS findings,
             json_array_length(o.vulns_json) AS vulns,
             (SELECT COUNT(*) FROM json_each(o.vulns_json)
              WHERE LOWER(COALESCE(json_extract(value, '$.severity'), '')) IN ('critical', 'high')) AS critical,
             json_extract(r.identity_json, '$.status') AS id_status,
             json_extract(r.identity_json, '$.anchor.url') AS anchor_url
      FROM latest_b b
      JOIN latest_o o ON o.owner = b.owner AND o.name = b.name AND o.rn = 1
      LEFT JOIN repos r ON r.owner = b.owner AND r.name = b.name
      WHERE b.rn = 1 AND o.status = 'queried' AND COALESCE(o.coverage_gate, '') = 'PASS'
    `).all();
    const passBreakdown = decomposeReasons(passRows);
    const verifiedAsResolved = Math.max(passBreakdown.verifiedAsResolved, row.signed_allow || 0);
    const verifiedAsNamed = passRows.filter(p =>
      Number(p.findings || 0) === 0 &&
      Number(p.vulns || 0) === 0 &&
      (p.id_status === 'CANONICAL_MATCH' || p.id_status === 'REDIRECTED') &&
      Boolean(p.anchor_url)
    ).length;

    const inputs = row.inputs || row.indexed || 0;
    const attempted = row.attempted || 0;
    const unattempted = row.inputs > 0 ? (row.unattempted || 0) : inputs;
    const ghosts = row.ghosts || 0;
    const resolved = row.resolved || 0;
    const staticScanned = row.static_scanned || 0;
    const osvQueried = row.osv_queried || 0;
    const verifiedWithEvidence = verifiedAsResolved;

    return {
      indexed: row.indexed || 0,
      inputs,
      attempted,
      unattempted,
      ghosts,
      duplicates: row.duplicates || 0,
      resolved,
      staticScanned,
      osvQueried,
      coveragePass: passBreakdown.passCoverage,
      verifiedWithEvidence,
      verifiedAsResolved,
      verifiedAsNamed,
      passBreakdown,
      chainSummary: `inputs=${inputs} attempted=${attempted} unattempted=${unattempted} ghosts=${ghosts} resolved=${resolved} static=${staticScanned} osv=${osvQueried} pass=${passBreakdown.passCoverage} verified=${verifiedAsResolved} (named=${verifiedAsNamed})`
    };
  } catch {
    return {
      indexed: 0, inputs: 0, attempted: 0, unattempted: 0, ghosts: 0, duplicates: 0,
      resolved: 0, staticScanned: 0, osvQueried: 0, verifiedWithEvidence: 0, chainSummary: ''
    };
  }
}
