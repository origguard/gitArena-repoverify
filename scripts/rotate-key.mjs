import { homedir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../src/db/database.mjs';
import { rotateSigningKey } from '../src/engines/integrity-registry.mjs';

/**
 * Rotation de Clé Ed25519 Hors-Arborescence — Runbook §1.3
 * Exige que la nouvelle clé réside hors du dépôt (process.cwd()).
 */

const reason = process.argv[2] || 'manual_key_rotation';
const targetPath = process.env.REPOVERIFY_SIGNING_KEY_PATH || join(homedir(), '.repoverify', 'keys', 'signing-ed25519.private.pem');

initDatabase();
const res = rotateSigningKey(reason, targetPath);
console.log(JSON.stringify(res, null, 2));
closeDatabase();
