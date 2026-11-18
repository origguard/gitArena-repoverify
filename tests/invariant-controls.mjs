#!/usr/bin/env node
/**
 * Mutation testing appliqué aux gates eux-mêmes.
 *
 * Un invariant n'est probant que si l'injection du défaut qu'il prétend
 * détecter le fait passer au ROUGE. Sinon il est DÉCORATIF.
 *
 * Fail-closed : un contrôle non instrumenté n'est PAS un passage.
 * Sortie : exit 1 si un seul contrôle est DÉCORATIF, NON_INSTRUMENTÉ ou ÉCHEC.
 *
 *   node tests/invariant-controls.mjs
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initDatabase, closeDatabase } from '../src/db/database.mjs';

async function tryImport(paths, pick) {
  for (const p of paths) {
    try { const m = await import(p); const f = pick(m); if (typeof f === 'function') return f; }
    catch { /* suivant */ }
  }
  return null;
}

const decide = await tryImport(
  ['../src/engines/evidence.mjs', './src/engines/evidence.mjs'], m => m.decide);
const evaluateGolden = await tryImport(
  ['./golden-eval.mjs', '../tests/golden-eval.mjs'], m => m.evaluateGolden ?? m.evaluate);
const badgeState = await tryImport(
  ['../src/engines/revocation.mjs'], m => m.badgeState);
const fingerprint = await tryImport(
  ['../src/engines/evidence.mjs', '../src/engines/integrity-registry.mjs'],
  m => m.computeCanonicalFingerprint ?? m.fingerprint ?? m.canonicalFingerprint);
const merkleVerify = await tryImport(
  ['../src/engines/merkle.mjs'], m => m.verifyProof);
const merkleBuild = await tryImport(
  ['../src/engines/merkle.mjs'], m => m.buildTree);
const merkleProof = await tryImport(
  ['../src/engines/merkle.mjs'], m => m.inclusionProof);
const gateCompleteness = await tryImport(
  ['../src/engines/completeness.mjs'], m => m.gateCompleteness);
const visibleAdvisories = await tryImport(
  ['../src/engines/completeness.mjs'], m => m.visibleAdvisories);
const identityVerdict = await tryImport(
  ['../src/engines/identity-anchor.mjs'], m => m.identityVerdict);
const decompose = await tryImport(
  ['../src/engines/completeness.mjs'], m => m.decomposeReasons);
const checkBand = await tryImport(
  ['../src/engines/completeness.mjs'], m => m.checkBand);
const blockCause = await tryImport(
  ['../src/engines/probe-depth.mjs'], m => m.blockCause);
const auditGateInputs = await tryImport(
  ['../src/engines/evidence.mjs'], m => m.auditGateInputs);
const extractDepsWithCoverage = await tryImport(
  ['../scripts/scan-corpus.mjs'], m => m.extractDepsWithCoverage);

const db = initDatabase();

const store = {
  all() {
    return db.prepare(`
      SELECT id, subject_repo_id, decision AS verdict, evidence_refs_json, keyid
      FROM integrity_signatures
    `).all().map(r => ({
      ...r,
      refs: JSON.parse(r.evidence_refs_json || '[]')
    }));
  },
  insert({ subject_repo_id, verdict, refs, keyid }) {
    const id = `ctrl-${randomUUID()}`;
    db.prepare(`
      INSERT INTO integrity_signatures (
        id, full_name, subject_repo_id, policy_profile, decision, trust_score,
        evidence_level, evidence_refs_json, keyid,
        violations_json, payload_json, signature_ed25519, public_key_pem, payload_sha256
      ) VALUES (?, ?, ?, 'enterprise', ?, 100, 3, ?, ?, '[]', '{}', 'sig', 'pub', 'sha')
    `).run(id, `ctrl/repo-${subject_repo_id}`, subject_repo_id, verdict, JSON.stringify(refs || []), keyid);
    return id;
  },
  remove(id) {
    db.prepare('DELETE FROM integrity_signatures WHERE id = ?').run(id);
  }
};

const llamaRow = db.prepare('SELECT id FROM repositories WHERE full_name = ?').get('ggml-org/llama.cpp');
const SCANNER_REPO_ID = Number(process.env.REPOVERIFY_SCANNER_REPO_ID ?? (llamaRow?.id || 0));
const REVOKED_KEYID = process.env.REPOVERIFY_OLD_KEYID ?? '006c745930d9cf08';

// Nettoyage si une ligne d'un précédent run existait pour REVOKED_KEYID de contrôle
const behavioralFactRow = db.prepare('SELECT id FROM behavioral_facts LIMIT 1').get();
const validFactRef = behavioralFactRow ? `behavioral_facts:${behavioralFactRow.id}` : 'behavioral_facts:1';

const UNKNOWN = { behavioral: null, osv: { scanned: false, ref: null }, execution: null };
const EMPTY_SONDES = [
  {}, { behavioral: null }, { osv: null }, { execution: null },
  { behavioral: {}, osv: {}, execution: {} },
  { behavioral: { scanMode: 'METADATA_ONLY' }, osv: { scanned: false } },
  { behavioral: { scanMode: 'STATIC' }, osv: { scanned: false } },
];
const probeI4 = d => { let n = 0; for (let i = 0; i < 100; i++) if (d(UNKNOWN).verdict === 'ALLOW') n++; return n === 0; };
const probeI1 = d => EMPTY_SONDES.every(s => d(s).verdict !== 'ALLOW');
const probeI2 = fp => {
  const fx = { owner: 'a', name: 'b', commit: 'c1', findings: [], scanMode: 'STATIC' };
  const a = fp(fx);
  return a === fp(fx)
    && fp({ ...fx, findings: [{ id: 'X', severity: 'low' }] }) !== a
    && fp({ ...fx, commit: 'c2' }) !== a;
};
const probeSelf = rows => !rows.some(r => r.subject_repo_id === SCANNER_REPO_ID);
const probeRefs = rows => !rows.some(r => r.verdict === 'ALLOW' && !(r.refs ?? []).length);
const probeOrphan = (rows, resolves) =>
  !rows.some(r => r.verdict === 'ALLOW' && (r.refs ?? []).some(x => !resolves(x)));
const probeRevoked = (rows, rev) => !rows.some(r => rev.includes(r.keyid));

const CONTROLS = [
  { id: 'C-01', inv: 'I4 · TEST-20', defect: 'défaut positif réintroduit sur dépôt inconnu',
    run: () => {
      if (!decide) return 'NON_INSTRUMENTÉ';
      const mutant = () => ({ verdict: 'ALLOW', evidenceLevel: 0, evidenceRefs: [] });
      return verdict(probeI4(decide), probeI4(mutant));
    } },

  { id: 'C-02', inv: 'I1 · TEST-21', defect: 'branche INDETERMINATE supprimée',
    run: () => {
      if (!decide) return 'NON_INSTRUMENTÉ';
      const mutant = inp => {
        const r = decide(inp);
        return r.verdict === 'INDETERMINATE' ? { ...r, verdict: 'ALLOW' } : r;
      };
      return verdict(probeI1(decide), probeI1(mutant));
    } },

  { id: 'C-03', inv: 'I2 · TEST-22', defect: 'fingerprint figé (le bug 729ceb84)',
    run: () => {
      if (!fingerprint) return 'NON_INSTRUMENTÉ';
      const mutant = () => '729ceb84322f3d6e';
      return verdict(probeI2(fingerprint), probeI2(mutant));
    } },

  { id: 'C-04', inv: 'I3 · TEST-23', defect: 'signature du scanner sur son propre dépôt',
    run: () => {
      if (!store || !SCANNER_REPO_ID) return 'NON_INSTRUMENTÉ';
      const base = store.all();
      const id = store.insert({ subject_repo_id: SCANNER_REPO_ID, verdict: 'ALLOW', refs: [validFactRef], keyid: 'x' });
      const mutated = probeSelf(store.all());
      store.remove(id);
      return verdict(probeSelf(base), mutated);
    } },

  { id: 'C-05', inv: 'I5a · TEST-24', defect: 'ALLOW sans evidenceRefs',
    run: () => {
      if (!store) return 'NON_INSTRUMENTÉ';
      const base = store.all();
      const id = store.insert({ subject_repo_id: 1, verdict: 'ALLOW', refs: [], keyid: 'x' });
      const mutated = probeRefs(store.all());
      store.remove(id);
      return verdict(probeRefs(base), mutated);
    } },

  { id: 'C-06', inv: 'I5b · TEST-24', defect: 'référence de preuve orpheline',
    run: () => {
      if (!store) return 'NON_INSTRUMENTÉ';
      const resolves = r => {
        const m = /^behavioral_facts:([1-9]\d*)$/.exec(r);
        if (!m) return false;
        return Boolean(db.prepare('SELECT 1 FROM behavioral_facts WHERE id = ?').get(Number(m[1])));
      };
      const base = store.all();
      const id = store.insert({ subject_repo_id: 2, verdict: 'ALLOW', refs: ['behavioral_facts:999999'], keyid: 'x' });
      const mutated = probeOrphan(store.all(), resolves);
      store.remove(id);
      return verdict(probeOrphan(base, resolves), mutated);
    } },

  { id: 'C-07', inv: 'I5c · TEST-24', defect: 'signature émise avec une clé révoquée',
    run: () => {
      if (!store) return 'NON_INSTRUMENTÉ';
      const revRows = db.prepare('SELECT keyid FROM revoked_keys').all().map(r => r.keyid);
      const rev = revRows.includes(REVOKED_KEYID) ? revRows : [...revRows, REVOKED_KEYID];
      const base = store.all();
      const id = store.insert({ subject_repo_id: 3, verdict: 'ALLOW', refs: [validFactRef], keyid: REVOKED_KEYID });
      const mutated = probeRevoked(store.all(), rev);
      store.remove(id);
      return verdict(probeRevoked(base, rev), mutated);
    } },

  { id: 'C-08', inv: 'gate golden', defect: 'jeu vide ou synthétique présenté comme probant',
    expect: 'doit échouer aujourd\'hui',
    run: () => {
      if (!evaluateGolden) return 'NON_INSTRUMENTÉ';
      const empty = evaluateGolden([], 0.62);
      const synth = evaluateGolden(
        Array.from({ length: 50 }, () => ({ trueClass: 'library', softwareScore: 0.9, annotated_by: null })), 0.62);
      const ok = empty.gate !== 'PASS' && synth.gate !== 'PASS';
      return ok ? 'PROBANT' : 'DÉCORATIF';
    } },

  { id: 'C-09', inv: 'gate golden', defect: 'non-logiciel scoré au-dessus du seuil',
    run: () => {
      if (!evaluateGolden) return 'NON_INSTRUMENTÉ';
      const set = [
        { trueClass: 'library', softwareScore: 0.90, annotated_by: 'a', arbitrated: true },
        { trueClass: 'courseware', softwareScore: 0.95, annotated_by: 'a', arbitrated: true },
      ];
      const r = evaluateGolden(set, 0.62);
      return (r.fpCert >= 1 && r.gate !== 'PASS') ? 'PROBANT' : 'DÉCORATIF';
    } },

  { id: 'C-10', inv: 'décroissance', defect: 'TTL ignoré par badgeState',
    run: () => {
      if (!badgeState) return 'NON_INSTRUMENTÉ';
      const att = { issued_at: '2026-01-01', revoked: null };
      const cfg = { ttl: 90, grace: 30 };
      const clean = badgeState(att, '2026-06-01', cfg).state === 'dead';
      const mutant = () => ({ state: 'live' });
      return verdict(clean, mutant(att, '2026-06-01', cfg).state === 'dead');
    } },

  { id: 'C-11', inv: 'séparation axes', defect: 'mode de scan dans le champ verdict',
    expect: 'doit échouer aujourd\'hui',
    run: () => {
      const src = ['src/engines/evidence.mjs', 'src/engines/behavioral-firewall.mjs', 'src/engines/pr-guard.mjs']
        .map(p => { try { return readFileSync(p, 'utf8'); } catch { return ''; } }).join('\n');
      if (!src) return 'NON_INSTRUMENTÉ';
      const conflation = /verdict\s*[:=]\s*['"]STATIC_CLEAN['"]/.test(src);
      return conflation ? 'DÉCORATIF' : 'PROBANT';
    } },

  { id: 'C-12', inv: 'journal Merkle', defect: 'vérificateur qui accepte toute preuve',
    run: () => {
      if (!merkleBuild || !merkleProof || !merkleVerify) return 'NON_INSTRUMENTÉ';
      const probe = vp => {
        const leaves = [{ i: 0, v: 'a' }, { i: 1, v: 'b' }, { i: 2, v: 'c' }];
        const t = merkleBuild(leaves);
        const proof = merkleProof(t.levels, 1);
        const tampered = { ...leaves[1], v: 'b-ALTERÉ' };
        return vp(tampered, proof, t.root).valid === false;
      };
      const mutant = () => ({ valid: true });
      return verdict(probe(merkleVerify), probe(mutant));
    } },
  { id: 'C-13', inv: 'I6 · complétude', defect: 'gate PASS quand 10/1010 deps interrogées',
    run: () => {
      if (!gateCompleteness) return 'NON_INSTRUMENTÉ';
      const cfg = { enabled: true, threshold: 0.98, requireTransitive: true };
      const probe = g => g({ lockfile: 'Cargo.lock', deps_declared: 10, deps_resolved: 1010, deps_queried: 10, transitive: true }, cfg).gate !== 'PASS';
      const mutant = () => ({ gate: 'PASS', cap: 'ALLOW' });
      return verdict(probe(gateCompleteness), probe(mutant));
    } },
  { id: 'C-14', inv: 'I6 · lockfile', defect: 'ALLOW sans lockfile',
    run: () => {
      if (!gateCompleteness) return 'NON_INSTRUMENTÉ';
      const cfg = { enabled: true, threshold: 0.98, requireTransitive: true };
      const probe = g => g({ lockfile: null, deps_declared: 5, deps_resolved: null, deps_queried: 5, transitive: false }, cfg).cap !== 'ALLOW';
      const mutant = () => ({ gate: 'PASS', cap: 'ALLOW' });
      return verdict(probe(gateCompleteness), probe(mutant));
    } },
  { id: 'C-15', inv: 'I6 · visibilité', defect: 'avis OSV sur paquet hors-périmètre retenu',
    run: () => {
      if (!visibleAdvisories) return 'NON_INSTRUMENTÉ';
      const advisories = [
        { id: 'RUSTSEC-X', package: 'bincode' },
        { id: 'GHSA-Y', package: 'pillow' },
      ];
      const probe = fn => fn(advisories, ['serde', 'tokio']).length === 0;
      const mutant = a => a;
      return verdict(probe(visibleAdvisories), probe(mutant));
    } },
  { id: 'C-16', inv: 'identité', defect: 'CANONICAL_MATCH sans ancre upstream indépendante',
    run: () => {
      if (!identityVerdict) return 'NON_INSTRUMENTÉ';
      const probe = fn => fn({ url: null }, { slug: 'a/b', id: 1 }).status === 'UNANCHORED';
      const mutant = () => ({ status: 'CANONICAL_MATCH', match: true });
      return verdict(probe(identityVerdict), probe(mutant));
    } },
  { id: 'C-17', inv: 'I7 · somme raisons', defect: 'décomposition qui ne somme pas',
    run: () => {
      if (!decompose) return 'NON_INSTRUMENTÉ';
      const rows = [
        ...Array.from({ length: 5 }, (_, i) => ({ findings: 1, vulns: 0, id: i })),
        ...Array.from({ length: 8 }, (_, i) => ({ findings: 0, vulns: 1, id: i + 10 })),
        ...Array.from({ length: 6 }, (_, i) => ({ findings: 2, vulns: 3, id: i + 20 })),
        { findings: 0, vulns: 0, id: 99 },
      ];
      const probe = d => {
        const r = d(rows);
        return (r.blockedFindingsOnly + r.blockedAdvisoriesOnly + r.blockedBoth + r.verifiedAsResolved) === rows.length && r.exactSum === true;
      };
      const mutant = () => ({ blockedFindingsOnly: 1, blockedAdvisoriesOnly: 1, blockedBoth: 1, verifiedAsResolved: 1, exactSum: false });
      return verdict(probe(decompose), probe(mutant));
    } },
  { id: 'C-18', inv: 'I7 · zéro chute', defect: 'un dépôt sans raison comptée',
    run: () => {
      if (!decompose) return 'NON_INSTRUMENTÉ';
      const clean20 = Array.from({ length: 20 }, (_, i) => ({ findings: 0, vulns: 0, id: i }));
      const probe = d => d(clean20).verifiedAsResolved === 20;
      const mutant = () => ({ blockedFindingsOnly: 0, blockedAdvisoriesOnly: 0, blockedBoth: 0, verifiedAsResolved: 0 });
      return verdict(probe(decompose), probe(mutant));
    } },
  { id: 'C-19', inv: 'I8 · bande sanity', defect: 'run accepté hors bande',
    run: () => {
      if (!checkBand) return 'NON_INSTRUMENTÉ';
      const probe = c => c(120, { lo: 5, hi: 40 }).within === false;
      const mutant = () => ({ within: true });
      return verdict(probe(checkBand), probe(mutant));
    } },
  { id: 'C-20', inv: 'origine cause', defect: 'cause probe publiée comme propriété du dépôt',
    run: () => {
      if (!blockCause) return 'NON_INSTRUMENTÉ';
      const located = {
        consulted: true,
        truncated: false,
        locks: [{ path: 'pnpm-lock.yaml', size: 3984588, depth: 0 }],
        pinned: [],
      };
      const probe = f => f({
        located,
        read: [],
        skipped: [{ path: 'pnpm-lock.yaml', size: 3984588, reason: 'over_cap' }],
        capBytes: 2097152,
        pinnedAccepted: false,
        ecoAllowed: ['pnpm-lock.yaml'],
      }).origin === 'probe';
      const mutant = () => ({ cause: 'NO_LOCKFILE', origin: 'repo', cap: 'WARN' });
      return verdict(probe(blockCause), probe(mutant));
    } },
  { id: 'C-21', inv: 'I9 · deps_answered', defect: 'deps_queried compté comme répondu sans deps_answered',
    run: () => {
      if (!gateCompleteness) return 'NON_INSTRUMENTÉ';
      const cfg = { enabled: true, threshold: 0.98, requireTransitive: true };
      const probe = g => g({
        lockfile: 'uv.lock',
        deps_declared: 30,
        deps_resolved: 181,
        deps_queried: 181,
        deps_answered: 0,
        transitive: true,
      }, cfg).cap !== 'ALLOW';
      const mutant = cov => cov.deps_queried >= 181 ? ({ gate: 'PASS', cap: 'ALLOW' }) : ({ gate: 'FAIL', cap: 'INDETERMINATE' });
      return verdict(probe(gateCompleteness), probe(mutant));
    } },
  { id: 'C-22', inv: 'I9 · findings null', defect: 'findings=null accepté comme [] et ALLOW',
    run: () => {
      if (!decide) return 'NON_INSTRUMENTÉ';
      const probe = d => d({
        behavioral: { scanMode: 'STATIC', ref: 'behavioral_facts:1', findings: null },
        osv: { scanned: true, ref: 'osv:1', maxSeverity: 'NONE' },
      }).verdict === 'INDETERMINATE';
      const mutant = () => ({ verdict: 'ALLOW' });
      return verdict(probe(decide), probe(mutant));
    } },
  { id: 'C-23', inv: 'I9 · truncated null', defect: 'truncated=null accepté comme non-tronqué',
    run: () => {
      if (!auditGateInputs) return 'NON_INSTRUMENTÉ';
      const base = {
        deps_resolved: 10, deps_queried: 10, deps_answered: 10,
        findings: [], vulns: [], lockfile_used: 'uv.lock',
        identity_status: 'CANONICAL_MATCH', scan_mode: 'STATIC',
        archived: false, license_spdx: 'MIT', coverage_gate: 'PASS',
        truncated: null,
      };
      const probe = fn => fn(base).cap !== 'ALLOW' && fn(base).missingOrOptimistic.includes('truncated');
      const mutant = () => ({ cap: 'ALLOW', missingOrOptimistic: [] });
      return verdict(probe(auditGateInputs), probe(mutant));
    } },
  { id: 'C-24', inv: 'I9 · archived null', defect: 'archived=null accepté comme false',
    run: () => {
      if (!auditGateInputs) return 'NON_INSTRUMENTÉ';
      const base = {
        deps_resolved: 10, deps_queried: 10, deps_answered: 10,
        findings: [], vulns: [], lockfile_used: 'uv.lock',
        identity_status: 'CANONICAL_MATCH', scan_mode: 'STATIC',
        archived: null, license_spdx: 'MIT', coverage_gate: 'PASS',
        truncated: false,
      };
      const probe = fn => fn(base).cap !== 'ALLOW' && fn(base).missingOrOptimistic.includes('archived');
      const mutant = () => ({ cap: 'ALLOW', missingOrOptimistic: [] });
      return verdict(probe(auditGateInputs), probe(mutant));
    } },
  { id: 'C-25', inv: 'I9 · uv.lock PEP440', defect: 'PEP 440 tronqué et editable compté comme PyPI',
    run: () => {
      if (!extractDepsWithCoverage) return 'NON_INSTRUMENTÉ';
      const uv = [
        '[[package]]', 'name = "pr-agent"', 'version = "0.49.0"', 'source = { editable = "." }',
        '[[package]]', 'name = "idna"', 'version = "3.18"', 'source = { registry = "https://pypi.org/simple" }',
        '[[package]]', 'name = "a2a-sdk"', 'version = "1.3.0"', 'source = { registry = "https://pypi.org/simple" }',
      ].join('\n');
      const probe = fn => {
        const res = fn({ 'uv.lock': uv });
        return res.deps.some(d => d.name === 'idna' && d.version === '3.18')
          && !res.deps.some(d => d.name === 'pr-agent')
          && res.depsResolved === 2;
      };
      const mutant = () => ({ deps: [{ name: 'pr-agent' }, { name: 'a2a-sdk', version: '1.3.0' }], depsResolved: 2 });
      return verdict(probe(extractDepsWithCoverage), probe(mutant));
    } },
];

function verdict(cleanPass, mutantPass) {
  if (!cleanPass) return 'ÉCHEC';
  if (mutantPass) return 'DÉCORATIF';
  return 'PROBANT';
}

const onlyArg = process.argv.find(a => a.startsWith('--only='));
const onlyIds = onlyArg ? new Set(onlyArg.slice(7).split(',').map(s => s.trim()).filter(Boolean)) : null;
const selectedControls = onlyIds ? CONTROLS.filter(c => onlyIds.has(c.id)) : CONTROLS;

const rows = [];
for (const c of selectedControls) {
  let r; try { r = c.run(); } catch (e) { r = 'ÉCHEC'; c.error = e.message; }
  rows.push({ ...c, result: r });
}
const pad = (s, n) => String(s).padEnd(n);
console.log('\nCONTRÔLES NÉGATIFS — les gates savent-ils échouer ?\n');
console.log(pad('ID', 7) + pad('INVARIANT', 18) + pad('DÉFAUT INJECTÉ', 48) + 'RÉSULTAT');
console.log('─'.repeat(96));
for (const r of rows) console.log(pad(r.id, 7) + pad(r.inv, 18) + pad(r.defect.slice(0, 46), 48) + r.result);
const bad = rows.filter(r => r.result !== 'PROBANT');
console.log('─'.repeat(96));
console.log(`${rows.length - bad.length}/${rows.length} PROBANTS · ${bad.length} à corriger`);
if (bad.length) {
  console.log('\nÀ corriger avant toute mesure sur le corpus :');
  bad.forEach(r => console.log(`  ${r.id} [${r.result}] ${r.defect}${r.error ? ' — ' + r.error : ''}`));
  console.log('\nUn contrôle NON_INSTRUMENTÉ n\'est pas un passage : brancher l\'adaptateur.');
}
closeDatabase();
process.exit(bad.length ? 1 : 0);
