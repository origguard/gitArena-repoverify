import { getDb } from '../db/database.mjs';

/**
 * Registre de Révocation & Décroissance Temporelle — Runbook §1.3 & II §11
 * Une clé ou signature révoquée reste lisible avec son motif et sa date (fail-closed).
 */

export const REVOCATION_TRIGGERS = Object.freeze([
  'private_key_exposed_in_git_history',
  'key_compromise',
  'archived',
  'license_changed',
  'tdm_reservation_appears',
  'dmca',
  'commit_gc',
  'branch_deleted'
]);

function daysBetween(isoA, nowDate = new Date()) {
  const a = new Date(isoA).getTime();
  const b = nowDate instanceof Date ? nowDate.getTime() : new Date(nowDate).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return (b - a) / 86400000;
}

export function badgeState(entry, nowDate = new Date(), cfg = {}) {
  const ttlDays = cfg.ttlDays ?? cfg.ttl ?? 90;
  const graceDays = cfg.graceDays ?? cfg.grace ?? 30;
  if (entry?.revoked) {
    return {
      state: 'dead',
      label: 'RÉVOQUÉE',
      reason: entry.revoked.reason || 'revoked'
    };
  }
  const age = daysBetween(entry?.issuedAt || entry?.issued_at, nowDate);
  if (age > ttlDays + graceDays) {
    return { state: 'dead', label: 'EXPIRÉE', reason: 'ttl_depasse' };
  }
  if (age > ttlDays) {
    return { state: 'stale', label: 'À REVÉRIFIER', reason: 'grace' };
  }
  return { state: 'live', label: 'VALIDE', reason: null };
}

export function revokeKeyId(keyid, reason = 'key_compromise', supersedes = null) {
  if (!keyid) throw new Error('keyid requis pour révocation');
  const db = getDb();
  const revokedAt = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO revoked_keys (keyid, revoked_at, reason, supersedes)
    VALUES (?, ?, ?, ?)
  `).run(String(keyid), revokedAt, String(reason), supersedes ? String(supersedes) : null);
  return { keyid, revokedAt, reason, supersedes };
}

export function isKeyRevoked(keyid) {
  if (!keyid) return false;
  try {
    const db = getDb();
    const row = db.prepare('SELECT keyid, revoked_at, reason, supersedes FROM revoked_keys WHERE keyid = ?').get(String(keyid));
    return row || false;
  } catch {
    return false;
  }
}

export function listRevokedKeys() {
  try {
    const db = getDb();
    return db.prepare('SELECT keyid, revoked_at, reason, supersedes FROM revoked_keys ORDER BY revoked_at DESC').all();
  } catch {
    return [];
  }
}
