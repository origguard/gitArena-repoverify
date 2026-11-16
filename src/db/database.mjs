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
