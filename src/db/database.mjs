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
