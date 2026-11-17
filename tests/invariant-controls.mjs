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

  { id: 'C-12', inv: 'journal Merkle', defect: 'preuve d\'inclusion tolérant une feuille altérée',
    run: () => {
      if (!merkleBuild || !merkleProof || !merkleVerify) return 'NON_INSTRUMENTÉ';
      const leaves = [{ r: 'a', v: 'ALLOW' }, { r: 'b', v: 'DENY' }, { r: 'c', v: 'INDETERMINATE' }];
      const { levels, root } = merkleBuild(leaves);
      const proof = merkleProof(levels, 1);
      const clean = merkleVerify(leaves[1], proof, root).valid === true;
      const tamperedValid = merkleVerify({ r: 'b', v: 'ALLOW' }, proof, root).valid === true;
      return verdict(clean, tamperedValid);
    } },
];

function verdict(cleanPass, mutantPass) {
  if (!cleanPass) return 'ÉCHEC';
  if (mutantPass) return 'DÉCORATIF';
  return 'PROBANT';
}

const rows = [];
for (const c of CONTROLS) {
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
