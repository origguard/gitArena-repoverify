import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let instance = null;

export function getDatabasePath() {
  const dbDir = join(__dirname, '../../data');
  mkdirSync(dbDir, { recursive: true });
  return join(dbDir, 'gitarena.sqlite');
}

export function initDatabase(dbPath = null) {
  const targetPath = dbPath || getDatabasePath();
  const db = new DatabaseSync(targetPath);

  // Optimisations WAL & performance
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  // Exécution du schéma
  const schemaPath = join(__dirname, 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);

  // Migration idempotente §2.2 & §4.4 : trust_attestations -> integrity_signatures + re-grade
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  if (tables.includes('trust_attestations')) {
    const legacyRows = db.prepare('SELECT * FROM trust_attestations').all();
    const insertMigrated = db.prepare(`
      INSERT OR IGNORE INTO integrity_signatures (
        id, full_name, subject_repo_id, policy_profile, decision, trust_score,
        evidence_level, evidence_refs_json, keyid, expires_at,
        violations_json, payload_json, signature_ed25519, public_key_pem, payload_sha256, issued_at
      ) VALUES (?, ?, NULL, ?, 'INDETERMINATE', ?, 1, '[]', NULL, NULL, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of legacyRows) {
      insertMigrated.run(
        r.id, r.full_name, r.policy_profile, r.trust_score,
        r.violations_json, r.payload_json, r.signature_ed25519, r.public_key_pem, r.payload_sha256, r.issued_at
      );
    }
    db.exec('DROP TABLE trust_attestations;');
  }

  db.exec(`
    UPDATE integrity_signatures
       SET evidence_level = 1,
           decision = 'INDETERMINATE'
     WHERE evidence_level IS NULL;
  `);

  // Migration idempotente §14 : ajout scan_scope & ref sur behavioral_facts
  const factCols = db.prepare('PRAGMA table_info(behavioral_facts)').all().map(c => c.name);
  if (!factCols.includes('scan_scope')) {
    db.exec('ALTER TABLE behavioral_facts ADD COLUMN scan_scope TEXT;');
  }
  if (!factCols.includes('ref')) {
    db.exec('ALTER TABLE behavioral_facts ADD COLUMN ref TEXT;');
  }

  // Migrations idempotentes §13-§14 : corpus_inputs.status, repos.identity_json, manifest_cache.manifest_probe_json
  const inputCols = db.prepare('PRAGMA table_info(corpus_inputs)').all().map(c => c.name);
  if (!inputCols.includes('status')) {
    db.exec("ALTER TABLE corpus_inputs ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';");
  }
  if (!inputCols.includes('resolved_id')) {
    db.exec('ALTER TABLE corpus_inputs ADD COLUMN resolved_id INTEGER;');
  }
  if (!inputCols.includes('last_error')) {
    db.exec('ALTER TABLE corpus_inputs ADD COLUMN last_error TEXT;');
  }
  if (!inputCols.includes('attempted_at')) {
    db.exec('ALTER TABLE corpus_inputs ADD COLUMN attempted_at TEXT;');
  }

  const repoCols = db.prepare('PRAGMA table_info(repos)').all().map(c => c.name);
  if (!repoCols.includes('identity_json')) {
    db.exec('ALTER TABLE repos ADD COLUMN identity_json TEXT;');
  }

  const manifestCols = db.prepare('PRAGMA table_info(manifest_cache)').all().map(c => c.name);
  if (!manifestCols.includes('manifest_probe_json')) {
    db.exec('ALTER TABLE manifest_cache ADD COLUMN manifest_probe_json TEXT;');
  }

  const osvCols = db.prepare('PRAGMA table_info(osv_queries)').all().map(c => c.name);
  if (!osvCols.includes('deps_declared')) {
    db.exec('ALTER TABLE osv_queries ADD COLUMN deps_declared INTEGER;');
  }
  if (!osvCols.includes('deps_resolved')) {
    db.exec('ALTER TABLE osv_queries ADD COLUMN deps_resolved INTEGER;');
  }
  if (!osvCols.includes('deps_queried')) {
    db.exec('ALTER TABLE osv_queries ADD COLUMN deps_queried INTEGER;');
  }
  if (!osvCols.includes('lockfile_used')) {
    db.exec('ALTER TABLE osv_queries ADD COLUMN lockfile_used TEXT;');
  }
  if (!osvCols.includes('coverage_gate')) {
    db.exec('ALTER TABLE osv_queries ADD COLUMN coverage_gate TEXT;');
  }

  const runCols = db.prepare('PRAGMA table_info(scan_runs)').all().map(c => c.name);
  if (!runCols.includes('cohort_id')) {
    db.exec('ALTER TABLE scan_runs ADD COLUMN cohort_id TEXT;');
  }

  // Réconciliation initiale si repos existaient déjà avant ajout de status sur corpus_inputs
  db.exec(`
    UPDATE corpus_inputs
       SET status = 'resolved',
           resolved_id = (SELECT r.id FROM repos r WHERE LOWER(r.full_name) = LOWER(corpus_inputs.input)),
           attempted_at = COALESCE(attempted_at, datetime('now'))
     WHERE status = 'pending'
       AND EXISTS (SELECT 1 FROM repos r WHERE LOWER(r.full_name) = LOWER(corpus_inputs.input));
  `);

  instance = db;
  return db;
}

export function getDb() {
  if (!instance) {
    return initDatabase();
  }
  return instance;
}

export function closeDatabase() {
  if (instance) {
    instance.close();
    instance = null;
  }
}
