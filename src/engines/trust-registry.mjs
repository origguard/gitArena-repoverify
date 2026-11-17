import { generateKeyPairSync, sign, verify, createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db/database.mjs';
import { inspectRepository } from './repo-service.mjs';
import { getLatestBehavioralAudit, scanTextBehavior, summarizeBehavioralFindings, persistBehavioralAudit } from './behavioral-firewall.mjs';

/**
 * Sovereign Trust Registry & Gatekeeper Ed25519 — Pilier 2 (RepoVerify / GitArena)
 * Délivre et vérifie hors-ligne des attestations signées Ed25519 pour bloquer ou autoriser
 * l'installation de dépôts par les agents IA (MCP gatekeep_install) et les CI/CD (PR Guard).
 * 100 % Natif Node.js ESM, zéro dépendance NPM.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const KEYS_DIR = join(__dirname, '../../data/keys');

let cachedKeys = null;

export function getOrInitSigningKeys() {
  if (cachedKeys) return cachedKeys;

  mkdirSync(KEYS_DIR, { recursive: true });
  const privPath = join(KEYS_DIR, 'trust-ed25519.private.pem');
  const pubPath = join(KEYS_DIR, 'trust-ed25519.public.pem');

  if (existsSync(privPath) && existsSync(pubPath)) {
    cachedKeys = {
      privateKeyPem: readFileSync(privPath, 'utf8'),
      publicKeyPem: readFileSync(pubPath, 'utf8')
    };
    return cachedKeys;
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  writeFileSync(privPath, privateKey, { mode: 0o600 });
  writeFileSync(pubPath, publicKey, 'utf8');

  cachedKeys = { privateKeyPem: privateKey, publicKeyPem: publicKey };
  return cachedKeys;
}

export function getPublicKeyInfo() {
  const { publicKeyPem } = getOrInitSigningKeys();
  const keyFingerprint = createHash('sha256').update(publicKeyPem).digest('hex');
  return { algorithm: 'Ed25519', keyFingerprint, publicKeyPem };
}

function getCachedBehaviorOrAnalyze(fullName) {
  const existing = getLatestBehavioralAudit(fullName);
  if (existing) return existing;

  // Sinon, analyser le tree/metadata GitIngest si déjà en cache
  try {
    const db = getDb();
    const gRow = db.prepare('SELECT tree_preview, dependencies_json FROM gitingest_cache WHERE full_name = ?').get(fullName);
    if (gRow) {
      const findings = scanTextBehavior((gRow.tree_preview || '') + '\n' + (gRow.dependencies_json || ''), 'gitingest-cache');
      const summary = summarizeBehavioralFindings(findings, 'CACHE_PREFLIGHT');
      return persistBehavioralAudit(fullName, summary);
    }
  } catch { /* ignore */ }

  return { verdict: 'TRUSTED_CLEAN', riskScore: 0, findingsCount: 0, findings: [], scanMode: 'METADATA_ONLY' };
}

function getCachedOsvSummary(fullName) {
  try {
    const db = getDb();
    const gRow = db.prepare('SELECT dependencies_json FROM gitingest_cache WHERE full_name = ?').get(fullName);
    if (!gRow) return { scanned: false, totalVulnerabilities: 0, maxSeverity: 'NONE' };
    const deps = JSON.parse(gRow.dependencies_json || '{}');
    const runtime = Array.isArray(deps.runtime) ? deps.runtime.slice(0, 25) : [];
    if (runtime.length === 0) return { scanned: false, totalVulnerabilities: 0, maxSeverity: 'NONE' };

    const placeholders = runtime.map(() => '?').join(',');
    const rows = db.prepare(`SELECT vuln_count, max_severity FROM osv_vuln_cache WHERE package_name IN (${placeholders})`).all(...runtime);
    if (rows.length === 0) return { scanned: false, totalVulnerabilities: 0, maxSeverity: 'NONE' };

    let total = 0;
    let maxSev = 'NONE';
    const rank = { CRITICAL: 4, HIGH: 3, MODERATE: 2, LOW: 1, NONE: 0 };
    for (const r of rows) {
      total += r.vuln_count || 0;
      if ((rank[r.max_severity] || 0) > (rank[maxSev] || 0)) maxSev = r.max_severity;
    }
    return { scanned: true, totalVulnerabilities: total, maxSeverity: maxSev };
  } catch {
    return { scanned: false, totalVulnerabilities: 0, maxSeverity: 'NONE' };
  }
}

/**
 * Évalue un dépôt inspecté selon les 5 portes Gatekeeper d'entreprise
 */
export function evaluateGatekeeperPolicy(inspectPayload, behaviorAudit, osvSummary, policyProfile = 'enterprise') {
  const { repository: repo, health, legalAndSecurity: legal } = inspectPayload;
  const violations = [];
  const warnings = [];
  let trustScore = 100;

  // Porte 1 : Licence commerciale BigCode
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

  // Porte 3 : Bus Factor (Mainteneurs)
  if (health.maintainerHealth?.available && health.maintainerHealth.busFactorRisk === 'HIGH') {
    if (policyProfile === 'strict') {
      violations.push({ gate: 'BUS_FACTOR_RISK', severity: 'BLOCKER', message: `Risque mono-mainteneur élevé (${health.maintainerHealth.topContributorShare}% par 1 contributeur).` });
      trustScore -= 20;
    } else {
      warnings.push({ gate: 'BUS_FACTOR_RISK', severity: 'WARN', message: `Bus Factor élevé (top contributeur ${health.maintainerHealth.topContributorShare}%).` });
      trustScore -= 10;
    }
  }

  // Porte 4 : Vulnérabilités Supply-Chain OSV.dev
  if (osvSummary?.scanned && (osvSummary.maxSeverity === 'CRITICAL' || osvSummary.maxSeverity === 'HIGH')) {
    violations.push({ gate: 'OSV_SUPPLY_CHAIN', severity: 'BLOCKER', message: `${osvSummary.totalVulnerabilities} vulnérabilité(s) OSV.dev (max: ${osvSummary.maxSeverity}).` });
    trustScore -= 30;
  }

  // Porte 5 : Behavioral Firewall
  if (behaviorAudit?.verdict === 'BLOCK_SUSPICIOUS') {
    violations.push({ gate: 'BEHAVIORAL_FIREWALL', severity: 'BLOCKER', message: `Comportement suspect détecté (Score risque ${behaviorAudit.riskScore}/100).` });
    trustScore -= 45;
  } else if (behaviorAudit?.verdict === 'REVIEW_REQUIRED') {
    warnings.push({ gate: 'BEHAVIORAL_FIREWALL', severity: 'WARN', message: `Signaux comportementaux à vérifier (${behaviorAudit.findingsCount} alerte(s)).` });
    trustScore -= 10;
  }

  trustScore = Math.max(0, Math.min(100, trustScore));

  let decision = 'ALLOW';
  if (violations.length > 0) decision = 'DENY';
  else if (warnings.length > 0) decision = 'WARN';

  return {
    decision,
    trustScore,
    policyProfile,
    violations,
    warnings,
    summary: {
      fullName: repo.full_name,
      license: legal.licenseSpdx,
      commercialSafe: legal.commercialSafe,
      aiScore: repo.ai_potential_score,
      elo: repo.elo_rating,
      busFactorRisk: health.maintainerHealth?.busFactorRisk || 'UNKNOWN',
      behavioralVerdict: behaviorAudit?.verdict || 'TRUSTED_CLEAN',
      osvMaxSeverity: osvSummary?.maxSeverity || 'NONE'
    }
  };
}

/**
 * Émet et signe (Ed25519) une attestation dans le Trust Registry SQLite
 */
export async function issueTrustAttestation(owner, name, options = {}) {
  const policyProfile = options.policyProfile || 'enterprise';
  const insp = await inspectRepository(owner, name, {
    includeLiveCi: options.includeLiveCi !== false,
    persistHarness: false
  });
  if (!insp.ok) {
    return { ok: false, status: insp.status, error: insp.payload?.error || 'Dépôt introuvable' };
  }

  const fullName = insp.payload.repository.full_name;
  const behaviorAudit = options.behaviorAudit || getCachedBehaviorOrAnalyze(fullName);
  const osvSummary = getCachedOsvSummary(fullName);

  const evaluation = evaluateGatekeeperPolicy(insp.payload, behaviorAudit, osvSummary, policyProfile);

  const attestationId = randomUUID();
  const issuedAt = new Date().toISOString();
  const payload = {
    schema: 'repoverify-trust-attestation/v1',
    id: attestationId,
    issuedAt,
    ...evaluation
  };

  const canonicalPayload = JSON.stringify(payload);
  const payloadSha256 = createHash('sha256').update(canonicalPayload).digest('hex');
  const { privateKeyPem, publicKeyPem } = getOrInitSigningKeys();
  const signatureEd25519 = sign(null, Buffer.from(canonicalPayload, 'utf8'), privateKeyPem).toString('base64');

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO trust_attestations (
        id, full_name, policy_profile, decision, trust_score,
        violations_json, payload_json, signature_ed25519, public_key_pem, payload_sha256, issued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attestationId,
      fullName,
      policyProfile,
      evaluation.decision,
      evaluation.trustScore,
      JSON.stringify(evaluation.violations),
      canonicalPayload,
      signatureEd25519,
      publicKeyPem,
      payloadSha256,
      issuedAt
    );
  } catch { /* ignore if DB unavailable in unit test */ }

  return {
    ok: true,
    attestation: {
      id: attestationId,
      fullName,
      decision: evaluation.decision,
      trustScore: evaluation.trustScore,
      policyProfile,
      violations: evaluation.violations,
      warnings: evaluation.warnings,
      summary: evaluation.summary,
      payload,
      payloadJson: canonicalPayload,
      payloadSha256,
      signatureEd25519,
      publicKeyPem,
      issuedAt
    }
  };
}

/**
 * Vérifie hors-ligne l'authenticité cryptographique d'une attestation Ed25519
 */
export function verifyTrustAttestation({ payloadJson, payload, signatureEd25519, publicKeyPem, payloadSha256 }) {
  try {
    const canonical = payloadJson || JSON.stringify(payload);
    if (!canonical || !signatureEd25519 || !publicKeyPem) {
      return { valid: false, reason: 'Champs cryptographiques incomplets' };
    }
    const computedHash = createHash('sha256').update(canonical).digest('hex');
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
      computedSha256: computedHash,
      reason: sigValid ? 'Signature Ed25519 authentique et intègre' : 'Signature Ed25519 invalide'
    };
  } catch (err) {
    return { valid: false, reason: `Erreur de vérification : ${err.message}` };
  }
}

export function getRecentTrustAttestations(limit = 20) {
  try {
    const db = getDb();
    return db.prepare(`
      SELECT id, full_name, policy_profile, decision, trust_score, violations_json, payload_sha256, issued_at
      FROM trust_attestations
      ORDER BY issued_at DESC
      LIMIT ?
    `).all(limit).map(r => ({
      ...r,
      violations: JSON.parse(r.violations_json || '[]')
    }));
  } catch {
    return [];
  }
}
