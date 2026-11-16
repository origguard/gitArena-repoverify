import { createHash } from 'node:crypto';
import { getDb } from '../db/database.mjs';

/**
 * Scanner de Vulnérabilités Supply-Chain OSV.dev — RepoVerify
 * Interroge l'API publique OSV.dev (zéro clé API) par lots avec cache SQLite 24h.
 */

const OSV_BATCH_API = 'https://api.osv.dev/v1/querybatch';
const OSV_TIMEOUT_MS = 5000;

const MANAGER_TO_ECOSYSTEM = {
  'npm / yarn / pnpm': 'npm',
  'pip': 'PyPI',
  'pip / poetry / hatch': 'PyPI',
  'cargo': 'crates.io',
  'go modules': 'Go'
};

export function mapManagerToEcosystem(manager = '') {
  return MANAGER_TO_ECOSYSTEM[manager] || null;
}

function classifySeverity(vuln) {
  const dbSpec = vuln.database_specific || {};
  if (dbSpec.severity) {
    return String(dbSpec.severity).toUpperCase();
  }
  const sevList = vuln.severity || [];
  for (const s of sevList) {
    if (s.score) {
      const num = parseFloat(String(s.score));
      if (!Number.isNaN(num)) {
        if (num >= 9.0) return 'CRITICAL';
        if (num >= 7.0) return 'HIGH';
        if (num >= 4.0) return 'MODERATE';
        return 'LOW';
      }
    }
  }
  return 'MODERATE';
}

const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MODERATE: 2, LOW: 1, NONE: 0 };

/**
 * Scanne les dépendances runtime via cache SQLite + OSV.dev querybatch
 * @param {object} dependencies - { manager, runtime: string[] }
 * @returns {Promise<object>} Rapport de vulnérabilités
 */
export async function scanDependenciesVulnerabilities(dependencies = {}) {
  const ecosystem = mapManagerToEcosystem(dependencies.manager);
  const packages = Array.isArray(dependencies.runtime)
    ? [...new Set(dependencies.runtime.filter(Boolean))].slice(0, 25)
    : [];

  if (!ecosystem || packages.length === 0) {
    return {
      scanned: false,
      ecosystem: ecosystem || 'Inconnu',
      packagesChecked: 0,
      vulnerablePackages: 0,
      totalVulnerabilities: 0,
      maxSeverity: 'NONE',
      findings: [],
      auditHash: createHash('sha256').update('osv:empty').digest('hex')
    };
  }

  const db = getDb();
  const findings = [];
  const toQuery = [];

  // 1. Lire le cache SQLite (< 24h)
  const selectCache = db.prepare(`
    SELECT * FROM osv_vuln_cache
    WHERE ecosystem = ? AND package_name = ? AND cached_at > datetime('now', '-24 hours')
  `);

  for (const pkg of packages) {
    try {
      const cached = selectCache.get(ecosystem, pkg);
      if (cached) {
        if (cached.vuln_count > 0) {
          findings.push({
            package: pkg,
            vulnCount: cached.vuln_count,
            maxSeverity: cached.max_severity,
            vulns: JSON.parse(cached.vulns_json || '[]'),
            fromCache: true
          });
        }
      } else {
        toQuery.push(pkg);
      }
    } catch {
      toQuery.push(pkg);
    }
  }

  // 2. Requête batch OSV.dev pour les paquets non en cache
  let networkError = null;
  if (toQuery.length > 0) {
    try {
      const queries = toQuery.map(name => ({ package: { name, ecosystem } }));
      const res = await fetch(OSV_BATCH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'RepoVerify-OSV-Scanner/3.0' },
        body: JSON.stringify({ queries }),
        signal: AbortSignal.timeout(OSV_TIMEOUT_MS)
      });

      if (res.ok) {
        const data = await res.json();
        const results = data.results || [];
        const upsertStmt = db.prepare(`
          INSERT OR REPLACE INTO osv_vuln_cache (
            ecosystem, package_name, vulns_json, vuln_count, max_severity, cached_at
          ) VALUES (?, ?, ?, ?, ?, datetime('now'))
        `);

        for (let i = 0; i < toQuery.length; i++) {
          const pkg = toQuery[i];
          const vulnsRaw = (results[i] && Array.isArray(results[i].vulns)) ? results[i].vulns : [];
          // Limiter aux 5 plus récentes par paquet pour la lisibilité
          const compactVulns = vulnsRaw.slice(0, 5).map(v => ({
            id: v.id,
            summary: v.summary || v.details?.slice(0, 120) || 'Vulnérabilité répertoriée OSV',
            severity: classifySeverity(v)
          }));

          let maxSev = 'NONE';
          for (const cv of compactVulns) {
            if ((SEVERITY_RANK[cv.severity] || 0) > (SEVERITY_RANK[maxSev] || 0)) {
              maxSev = cv.severity;
            }
          }

          try {
            upsertStmt.run(ecosystem, pkg, JSON.stringify(compactVulns), vulnsRaw.length, maxSev);
          } catch { /* ignore cache write issue */ }

          if (vulnsRaw.length > 0) {
            findings.push({
              package: pkg,
              vulnCount: vulnsRaw.length,
              maxSeverity: maxSev,
              vulns: compactVulns,
              fromCache: false
            });
          }
        }
      } else {
        networkError = `HTTP ${res.status}`;
      }
    } catch (err) {
      networkError = err.message;
    }
  }

  // Trier par gravité décroissante
  findings.sort((a, b) => (SEVERITY_RANK[b.maxSeverity] || 0) - (SEVERITY_RANK[a.maxSeverity] || 0));

  let overallMax = 'NONE';
  let totalVulns = 0;
  for (const f of findings) {
    totalVulns += f.vulnCount;
    if ((SEVERITY_RANK[f.maxSeverity] || 0) > (SEVERITY_RANK[overallMax] || 0)) {
      overallMax = f.maxSeverity;
    }
  }

  const auditHash = createHash('sha256')
    .update(`${ecosystem}:${packages.join(',')}:${totalVulns}:${overallMax}`)
    .digest('hex');

  return {
    scanned: networkError === null || findings.length > 0,
    ecosystem,
    packagesChecked: packages.length,
    vulnerablePackages: findings.length,
    totalVulnerabilities: totalVulns,
    maxSeverity: overallMax,
    findings: findings.slice(0, 10),
    networkError,
    auditHash
  };
}
