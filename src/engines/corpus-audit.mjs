import { initDatabase, closeDatabase } from '../db/database.mjs';

/**
 * Audit d'Existence & Déduplication Canonique du Corpus — Runbook II §7
 * Zéro id numérique = zéro entrée légitime. Deux entrées de même id = un seul dépôt.
 * 100 % Natif Node.js ESM.
 */

export async function verifyExistence(fullName, token = process.env.GITHUB_TOKEN || '') {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'RepoVerify-CorpusAudit/1.0'
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`https://api.github.com/repos/${fullName}`, { headers });
  if (res.status === 404 || res.status === 451) {
    return { input: fullName, exists: false, reason: `http_${res.status}` };
  }
  if (!res.ok) {
    return { input: fullName, exists: null, reason: `http_${res.status}` };
  }

  const data = await res.json();
  let canonical = data.full_name || fullName;
  try {
    const pathname = new URL(res.url).pathname.split('/').filter(Boolean);
    if (pathname.length >= 2) {
      canonical = data.full_name || `${pathname[pathname.length - 2]}/${pathname[pathname.length - 1]}`;
    }
  } catch { /* fallback to full_name */ }

  return {
    input: fullName,
    exists: true,
    canonical,
    id: data.id,
    archived: Boolean(data.archived),
    fork: Boolean(data.fork),
    parent: data.parent?.full_name ?? null,
    stars: data.stargazers_count ?? 0,
    language: data.language ?? null,
    license: data.license?.spdx_id ?? null,
    pushed_at: data.pushed_at ?? null
  };
}

export function dedupe(rows) {
  const seen = new Map();
  const ghosts = [];
  const dupes = [];
  const forks = [];
  const drift = [];

  for (const r of rows) {
    if (!r || !r.exists || !r.id) {
      ghosts.push(r);
      continue;
    }
    if (seen.has(r.id)) {
      dupes.push({ ...r, canonical_of: seen.get(r.id) });
      continue;
    }
    const canonName = r.canonical || r.full_name || r.input;
    seen.set(r.id, canonName);
    if (r.fork && r.parent) forks.push(r);
    const starsClaimed = Number(r.stars_claimed ?? r.stars ?? 0);
    const starsReal = Number(r.stars ?? 0);
    if (starsReal > 0 && Math.abs(starsClaimed - starsReal) / Math.max(1, starsReal) > 0.2) {
      drift.push(r);
    }
  }

  return {
    kept: [...seen.values()],
    ghosts,
    dupes,
    forks,
    drift
  };
}

if (process.argv[1] && process.argv[1].endsWith('corpus-audit.mjs')) {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Math.max(1, parseInt(args[limitIdx + 1], 10) || 20) : 20;

  const db = initDatabase();
  const sample = db.prepare('SELECT id, full_name, stars FROM repositories LIMIT ?').all(limit);
  const results = [];
  for (const row of sample) {
    const check = await verifyExistence(row.full_name);
    results.push({ ...check, stars_claimed: row.stars });
  }
  const summary = dedupe(results);
  console.log(JSON.stringify({
    audited: results.length,
    keptCount: summary.kept.length,
    ghostsCount: summary.ghosts.length,
    dupesCount: summary.dupes.length,
    forksCount: summary.forks.length,
    starsDriftCount: summary.drift.length,
    ghosts: summary.ghosts,
    dupes: summary.dupes
  }, null, 2));
  closeDatabase();
}
