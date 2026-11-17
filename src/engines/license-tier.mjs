import { sign, verify } from 'node:crypto';
import { getDb } from '../db/database.mjs';
import { getOrInitSigningKeys } from './integrity-registry.mjs';

/**
 * Plan de Contrôle Open-Core & Licences Ed25519 Hors-Ligne — Pilier 4
 * Distingue le mode Community (Apache-2.0 local gratuit) des déploiements
 * Pro / Enterprise (clés Ed25519 vérifiées localement sans serveur de licence tiers).
 */

export const TIERS = {
  community: { id: 'community', label: 'Community (Apache-2.0 Local)', dailyLimit: 500, strictPrGuard: false },
  pro: { id: 'pro', label: 'Pro (Équipes & PR Guard)', dailyLimit: 10000, strictPrGuard: true },
  enterprise: { id: 'enterprise', label: 'Enterprise (Sovereign Registry)', dailyLimit: 1000000, strictPrGuard: true }
};

export function issueOrgLicense({ orgId, tier = 'pro', validDays = 365 }) {
  if (!orgId || !TIERS[tier]) {
    throw new Error('orgId valide et tier (community|pro|enterprise) requis');
  }

  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + validDays * 86400000).toISOString();
  const payload = { orgId, tier, issuedAt, expiresAt };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

  const { privateKeyPem } = getOrInitSigningKeys();
  const sigB64 = sign(null, Buffer.from(payloadB64, 'utf8'), privateKeyPem).toString('base64url');
  const token = `rv1.${payloadB64}.${sigB64}`;

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO org_policies (org_id, tier, policy_json, license_token, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(org_id) DO UPDATE SET
        tier = excluded.tier,
        policy_json = excluded.policy_json,
        license_token = excluded.license_token,
        updated_at = datetime('now')
    `).run(orgId, tier, JSON.stringify(TIERS[tier]), token);
  } catch { /* ignore if DB uninitialized */ }

  return { token, payload };
}

export function verifyOrgLicense(token) {
  if (!token || typeof token !== 'string' || !token.startsWith('rv1.')) {
    return { valid: false, reason: 'Format de jeton invalide (préfixe rv1. attendu)' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'Structure de jeton malformée' };
  }

  try {
    const [, payloadB64, sigB64] = parts;
    const { publicKeyPem } = getOrInitSigningKeys();
    const ok = verify(
      null,
      Buffer.from(payloadB64, 'utf8'),
      publicKeyPem,
      Buffer.from(sigB64, 'base64url')
    );
    if (!ok) {
      return { valid: false, reason: 'Signature Ed25519 invalide' };
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.expiresAt && new Date(payload.expiresAt).getTime() < Date.now()) {
      return { valid: false, reason: 'Licence expirée', payload };
    }

    return {
      valid: true,
      orgId: payload.orgId,
      tier: payload.tier,
      tierMeta: TIERS[payload.tier] || TIERS.community,
      expiresAt: payload.expiresAt
    };
  } catch (err) {
    return { valid: false, reason: `Erreur de vérification : ${err.message}` };
  }
}

export function resolveRequestLicenseContext(req) {
  const requireKey = process.env.REPOVERIFY_REQUIRE_API_KEY === 'true';
  const rawHeader = req.headers['x-repoverify-key'] || req.headers['authorization'] || '';
  const token = String(rawHeader).replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    if (requireKey) {
      return { authorized: false, status: 401, error: 'Clé API / Licence RepoVerify requise (X-RepoVerify-Key).' };
    }
    return { authorized: true, orgId: 'local-community', tier: 'community', tierMeta: TIERS.community };
  }

  const check = verifyOrgLicense(token);
  if (!check.valid) {
    return { authorized: false, status: 403, error: check.reason };
  }
  return { authorized: true, orgId: check.orgId, tier: check.tier, tierMeta: check.tierMeta };
}

export function getOrgPoliciesSnapshot() {
  try {
    const db = getDb();
    return db.prepare('SELECT org_id, tier, policy_json, updated_at FROM org_policies ORDER BY updated_at DESC LIMIT 20').all();
  } catch {
    return [];
  }
}
