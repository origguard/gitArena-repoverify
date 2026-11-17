import { getDb } from '../db/database.mjs';
import { buildGithubHeaders } from './ci-telemetry.mjs';

/**
 * Télémétrie Mainteneurs & Bus Factor — RepoVerify
 * Analyse les contributeurs principaux et la dernière release GitHub
 * pour détecter les risques de mono-mainteneur (Bus Factor = 1) ou d'abandon.
 */

const TIMEOUT_MS = 5500;

export function classifyBusFactorRisk(contributorsCount, topSharePercent) {
  if (contributorsCount <= 1 || (contributorsCount <= 2 && topSharePercent >= 85)) {
    return 'HIGH';
  }
  if (contributorsCount < 4 || topSharePercent >= 70) {
    return 'MODERATE';
  }
  return 'LOW';
}

export function getCachedMaintainerHealthSync(fullName) {
  try {
    const db = getDb();
    const cached = db.prepare(`
      SELECT * FROM maintainer_health_cache
      WHERE full_name = ? AND cached_at > datetime('now', '-12 hours')
    `).get(fullName);
    if (!cached) return null;
    const raw = JSON.parse(cached.raw_json || '{}');
    return {
      available: true,
      contributorsSampled: cached.contributors_count,
      topContributorShare: cached.top_contributor_share,
      busFactorRisk: cached.bus_factor_risk,
      latestReleaseTag: cached.latest_release_tag,
      latestReleaseAt: cached.latest_release_at,
      daysSinceLastRelease: cached.latest_release_at
        ? Math.max(0, Math.round((Date.now() - new Date(cached.latest_release_at).getTime()) / 86400000))
        : null,
      topContributors: raw.topContributors || [],
      fromCache: true
    };
  } catch {
    return null;
  }
}

export async function fetchMaintainerHealth(owner, name) {
  const fullName = `${owner}/${name}`;
  const cached = getCachedMaintainerHealthSync(fullName);
  if (cached) return cached;

  const headers = buildGithubHeaders();

  try {
    const [contribRes, releaseRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contributors?per_page=10&anon=false`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      }),
      fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/latest`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    ]);

    if (contribRes.status === 403 || contribRes.status === 429) {
      return {
        available: false,
        rateLimited: true,
        busFactorRisk: 'UNKNOWN',
        source: 'GitHub API Rate-Limited'
      };
    }

    let contributorsSampled = 0;
    let topContributorShare = 100;
    let topContributors = [];

    if (contribRes.ok) {
      const contribs = await contribRes.json();
      if (Array.isArray(contribs) && contribs.length > 0) {
        contributorsSampled = contribs.length;
        const totalTopCommits = contribs.reduce((sum, c) => sum + (c.contributions || 0), 0);
        const topCommits = contribs[0]?.contributions || 0;
        topContributorShare = totalTopCommits > 0
          ? Math.round((topCommits / totalTopCommits) * 1000) / 10
          : 100;
        topContributors = contribs.slice(0, 5).map(c => ({
          login: c.login,
          contributions: c.contributions
        }));
      }
    }

    let latestReleaseTag = null;
    let latestReleaseAt = null;
    if (releaseRes.ok) {
      const rel = await releaseRes.json();
      latestReleaseTag = rel.tag_name || rel.name || null;
      latestReleaseAt = rel.published_at || rel.created_at || null;
    }

    const busFactorRisk = contributorsSampled > 0
      ? classifyBusFactorRisk(contributorsSampled, topContributorShare)
      : 'UNKNOWN';

    if (contributorsSampled > 0 || latestReleaseTag) {
      try {
        const db = getDb();
        db.prepare(`
          INSERT OR REPLACE INTO maintainer_health_cache (
            full_name, contributors_count, top_contributor_share,
            latest_release_tag, latest_release_at, bus_factor_risk, raw_json, cached_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          fullName,
          contributorsSampled,
          topContributorShare,
          latestReleaseTag,
          latestReleaseAt,
          busFactorRisk,
          JSON.stringify({ topContributors })
        );
      } catch { /* ignore cache write error */ }
    }

    return {
      available: contributorsSampled > 0 || Boolean(latestReleaseTag),
      contributorsSampled,
      topContributorShare,
      busFactorRisk,
      latestReleaseTag,
      latestReleaseAt,
      daysSinceLastRelease: latestReleaseAt
        ? Math.max(0, Math.round((Date.now() - new Date(latestReleaseAt).getTime()) / 86400000))
        : null,
      topContributors,
      fromCache: false
    };
  } catch (err) {
    return {
      available: false,
      busFactorRisk: 'UNKNOWN',
      source: `Indisponible (${err.message})`
    };
  }
}
