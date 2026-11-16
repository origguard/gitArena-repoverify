import { getDb } from '../db/database.mjs';

/**
 * Télémétrie CI/CD Réelle (GitHub Actions API) — RepoVerify
 * Récupère les vrais runs CI/CD d'un dépôt avec cache SQLite 6h et gestion du rate-limit.
 */

const GITHUB_TIMEOUT_MS = 6000;

export function buildGithubHeaders() {
  const headers = {
    'User-Agent': 'RepoVerify-Sovereign-Engine/3.0 (+https://github.com/RepoVerify)',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

/**
 * Récupère la télémétrie GitHub Actions pour owner/name
 * @param {string} owner
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function fetchCiTelemetry(owner, name) {
  const fullName = `${owner}/${name}`;
  const db = getDb();

  // 1. Vérifier le cache (< 6 heures)
  try {
    const cached = db.prepare(`
      SELECT * FROM ci_telemetry_cache
      WHERE full_name = ? AND cached_at > datetime('now', '-6 hours')
    `).get(fullName);

    if (cached) {
      return {
        available: true,
        source: 'GitHub Actions (Cache 6h)',
        ciPassRate: cached.ci_pass_rate,
        lastRunStatus: cached.last_run_status,
        lastRunAt: cached.last_run_at,
        workflowsCount: cached.workflows_count,
        recentRuns: JSON.parse(cached.actions_json || '[]'),
        fromCache: true
      };
    }
  } catch { /* cache non initialisé */ }

  // 2. Appel API GitHub Actions
  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs?per_page=8`;
    const res = await fetch(url, {
      headers: buildGithubHeaders(),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
    });

    if (res.status === 403 || res.status === 429) {
      const resetEpoch = res.headers.get('x-ratelimit-reset');
      return {
        available: false,
        source: 'GitHub API Rate-Limited',
        rateLimited: true,
        retryAfter: resetEpoch ? new Date(Number(resetEpoch) * 1000).toISOString() : null,
        recentRuns: []
      };
    }

    if (!res.ok) {
      return {
        available: false,
        source: `GitHub Actions HTTP ${res.status}`,
        recentRuns: []
      };
    }

    const data = await res.json();
    const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
    const completed = runs.filter(r => r.status === 'completed' && r.conclusion);

    const passedRuns = completed.filter(r => r.conclusion === 'success').length;
    const ciPassRate = completed.length > 0
      ? Math.round((passedRuns / completed.length) * 1000) / 10
      : null;

    const compactRuns = runs.slice(0, 5).map(r => ({
      id: r.id,
      name: r.name || 'CI Workflow',
      status: r.status,
      conclusion: r.conclusion || 'in_progress',
      branch: r.head_branch,
      updatedAt: r.updated_at,
      url: r.html_url
    }));

    const latest = compactRuns[0] || null;
    const lastRunStatus = latest ? (latest.conclusion || latest.status).toUpperCase() : 'NO_RUNS';
    const lastRunAt = latest ? latest.updatedAt : null;

    try {
      db.prepare(`
        INSERT OR REPLACE INTO ci_telemetry_cache (
          full_name, actions_json, ci_pass_rate, last_run_status, last_run_at, workflows_count, cached_at
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        fullName,
        JSON.stringify(compactRuns),
        ciPassRate,
        lastRunStatus,
        lastRunAt,
        data.total_count || runs.length
      );
    } catch { /* ignore cache write error */ }

    return {
      available: runs.length > 0,
      source: runs.length > 0 ? 'GitHub Actions (Live)' : 'Aucun workflow GitHub Actions',
      ciPassRate,
      lastRunStatus,
      lastRunAt,
      workflowsCount: data.total_count || runs.length,
      recentRuns: compactRuns,
      fromCache: false
    };
  } catch (err) {
    return {
      available: false,
      source: `Indisponible (${err.message})`,
      recentRuns: []
    };
  }
}
