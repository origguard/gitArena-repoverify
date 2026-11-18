#!/usr/bin/env node
/**
 * scripts/scan-corpus.mjs — Indexeur trois étages : resolve -> scan -> osv (Runbook III)
 * Écrit des FAITS (repos, behavioral_facts, osv_queries), jamais des verdicts.
 * Fail-closed sur chaque entrée. 100 % Natif Node.js ESM, zéro dépendance NPM.
 *
 * Usage :
 *   GITHUB_TOKEN=ghp_... node scripts/scan-corpus.mjs --stage=resolve --limit=500
 *   GITHUB_TOKEN=ghp_... node scripts/scan-corpus.mjs --stage=scan --fetch=tarball --limit=500
 *   node scripts/scan-corpus.mjs --stage=osv --limit=500
 *   node scripts/scan-corpus.mjs --census
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../src/db/database.mjs';
import { scanBlobsBehavior } from '../src/engines/behavioral-firewall.mjs';

const TARGET_FILES_SET = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt',
  'Cargo.toml', 'go.mod', 'composer.json', 'Gemfile', 'pom.xml', 'build.gradle',
  'setup.py', 'scripts/setup.js', 'scripts/postinstall.js', 'bin/install.sh'
]);

const SCANNER_VERSION = 'scanner_v0.5';
const MANIFESTS = [
  'package.json', 'pyproject.toml', 'requirements.txt',
  'Cargo.toml', 'go.mod', 'composer.json', 'Gemfile', 'pom.xml', 'build.gradle'
];
const HOOK_FILES = [
  'setup.py', 'scripts/setup.js', 'scripts/postinstall.js', 'bin/install.sh'
];
const ECO = {
  'package.json': 'npm',
  'requirements.txt': 'PyPI',
  'pyproject.toml': 'PyPI',
  'Cargo.toml': 'crates.io',
  'go.mod': 'Go'
};

function loadDotEnvToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const envPath = join(process.cwd(), '.env');
    if (!existsSync(envPath)) return '';
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = /^\s*GITHUB_TOKEN\s*=\s*(.+)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* ignore */ }
  return '';
}

const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

async function fetchGitHub(url, headers, apiCounter) {
  apiCounter.calls++;
  const res = await fetch(url, { headers });
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const resetSec = Number(res.headers.get('x-ratelimit-reset') || 0);
    const waitMs = Math.min(60000, Math.max(1000, resetSec * 1000 - Date.now()));
    console.warn(`[INDEXER] Rate-limit GitHub atteint : pause ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
    return fetchGitHub(url, headers, apiCounter);
  }
  return res;
}

/**
 * Extrait les dépendances épinglées depuis un dictionnaire de blobs lus
 */
export function extractDeps(blobs = {}) {
  const out = [];
  for (const [file, text] of Object.entries(blobs || {})) {
    if (typeof text !== 'string') continue;
    const base = file.split('/').pop();
    const eco = ECO[base];
    if (!eco) continue;

    if (eco === 'npm') {
      let pkg;
      try { pkg = JSON.parse(text); } catch { continue; }
      for (const [name, ver] of Object.entries({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) {
        out.push({
          name,
          ecosystem: 'npm',
          version: String(ver).replace(/^[\^~>=<\s]+/, '')
        });
      }
    } else if (base === 'requirements.txt') {
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9._-]+)\s*==\s*([0-9][^\s;#]*)/.exec(line);
        if (m) out.push({ name: m[1], ecosystem: 'PyPI', version: m[2] });
      }
    } else if (base === 'pyproject.toml') {
      for (const m of text.matchAll(/["']([A-Za-z0-9._-]+)\s*==\s*([0-9][^"'\s;,]*)["']/g)) {
        out.push({ name: m[1], ecosystem: 'PyPI', version: m[2] });
      }
    } else if (eco === 'crates.io') {
      let inDepsSection = false;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) {
          inDepsSection = /^\[(dependencies|dev-dependencies|build-dependencies|workspace\.dependencies)\]/i.test(trimmed);
          continue;
        }
        if (!inDepsSection || !trimmed || trimmed.startsWith('#')) continue;
        const m = /^([A-Za-z0-9_-]+)\s*=\s*"([0-9][^"]*)"/.exec(trimmed);
        if (m) out.push({ name: m[1], ecosystem: 'crates.io', version: m[2] });
      }
    } else if (eco === 'Go') {
      for (const m of text.matchAll(/^\s*([^\s/]+\/[^\s]+)\s+v([0-9][^\s/]*)/gm)) {
        out.push({ name: m[1], ecosystem: 'Go', version: m[2] });
      }
    }
  }
  return out.filter(d => /^\d+\.\d+/.test(d.version));
}

/**
 * Recensement dérivé strictement des faits persistés (Runbook III §16.1)
 */
export function computeCensus(db) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM corpus_inputs) AS inputs,
      (SELECT COUNT(*) FROM repositories) AS indexed,
      (SELECT COUNT(*) FROM repos) AS resolved,
      (SELECT COUNT(DISTINCT owner || '/' || name) FROM behavioral_facts WHERE scan_mode = 'STATIC') AS static_scanned,
      (SELECT COUNT(DISTINCT owner || '/' || name) FROM osv_queries WHERE status = 'queried') AS osv_queried,
      (SELECT COUNT(*) FROM (
        SELECT b.owner, b.name
        FROM behavioral_facts b
        JOIN osv_queries o ON o.owner = b.owner AND o.name = b.name
        WHERE b.scan_mode = 'STATIC'
          AND o.status = 'queried'
          AND json_array_length(b.findings_json) = 0
          AND json_array_length(o.vulns_json) = 0
        GROUP BY b.owner, b.name
      )) AS verified_with_evidence
  `).get();

  return {
    inputs: row.inputs || 0,
    indexed: row.indexed || 0,
    resolved: row.resolved || 0,
    staticScanned: row.static_scanned || 0,
    osvQueried: row.osv_queried || 0,
    verifiedWithEvidence: row.verified_with_evidence || 0
  };
}

function seedCorpusInputsIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM corpus_inputs').get().cnt;
  if (count === 0) {
    db.exec(`
      INSERT OR IGNORE INTO corpus_inputs (input, added_at)
      SELECT full_name, datetime('now') FROM repositories;
    `);
  }
}

export async function resolveStage(db, { limit = 500, delayMs = 120, dryRun = false, force = false, headers, failures, apiCounter }) {
  seedCorpusInputsIfEmpty(db);
  const inputs = force
    ? db.prepare('SELECT input FROM corpus_inputs LIMIT ?').all(limit)
    : db.prepare(`
        SELECT input FROM corpus_inputs c
        WHERE NOT EXISTS (SELECT 1 FROM repos r WHERE LOWER(r.full_name) = LOWER(c.input))
        LIMIT ?
      `).all(limit);
  const seen = new Map();
  let ghosts = 0;
  let dupes = 0;

  const upsertRepo = db.prepare(`
    INSERT INTO repos (id, owner, name, full_name, default_branch, archived, fork, stars, language, license, pushed_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner = excluded.owner,
      name = excluded.name,
      full_name = excluded.full_name,
      default_branch = excluded.default_branch,
      archived = excluded.archived,
      fork = excluded.fork,
      stars = excluded.stars,
      language = excluded.language,
      license = excluded.license,
      pushed_at = excluded.pushed_at,
      resolved_at = excluded.resolved_at
  `);

  for (const { input } of inputs) {
    try {
      const r = await fetchGitHub(`https://api.github.com/repos/${input}`, headers, apiCounter);
      if (r.status === 404 || r.status === 451) {
        ghosts++;
        failures.push({ stage: 'resolve', input, reason: `http_${r.status}` });
        await sleep(delayMs);
        continue;
      }
      if (!r.ok) {
        failures.push({ stage: 'resolve', input, reason: `http_${r.status}` });
        await sleep(delayMs);
        continue;
      }
      const d = await r.json();
      if (!d.id) {
        ghosts++;
        failures.push({ stage: 'resolve', input, reason: 'missing_numeric_id' });
        await sleep(delayMs);
        continue;
      }
      if (seen.has(d.id)) {
        dupes++;
        await sleep(delayMs);
        continue;
      }
      seen.set(d.id, true);

      let canonical = d.full_name || input;
      try {
        const segs = new URL(r.url).pathname.split('/').filter(Boolean);
        if (segs.length >= 2 && !d.full_name) {
          canonical = `${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
        }
      } catch { /* fallback to full_name */ }
      const [canonOwner, canonName] = canonical.split('/');
      if (!dryRun && canonOwner && canonName) {
        upsertRepo.run(
          d.id,
          canonOwner,
          canonName,
          canonical,
          d.default_branch || 'main',
          d.archived ? 1 : 0,
          d.fork ? 1 : 0,
          d.stargazers_count || 0,
          d.language || null,
          d.license?.spdx_id ?? null,
          d.pushed_at || null,
          new Date().toISOString()
        );
      }
    } catch (err) {
      failures.push({ stage: 'resolve', input, reason: err.message });
    }
    await sleep(delayMs);
  }

  return { resolved: seen.size, ghosts, dupes };
}

export function extractTarballManifestsFromBuffer(gzipBuffer) {
  const tarBuf = gunzipSync(gzipBuffer);
  const blobs = {};
  let offset = 0;
  let nextLongName = null;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;

    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const rawPrefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const sizeOct = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
    const size = sizeOct ? parseInt(sizeOct, 8) : 0;
    const typeFlag = String.fromCharCode(header[156] || 48);

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const paddedBlocks = Math.ceil(size / 512) * 512;
    offset = dataStart + paddedBlocks;

    if (!Number.isFinite(size) || size < 0 || dataEnd > tarBuf.length) break;

    if (typeFlag === 'L') {
      nextLongName = tarBuf.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/, '');
      continue;
    }

    const fullPath = nextLongName || (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
    nextLongName = null;

    if ((typeFlag === '0' || typeFlag === '\0' || typeFlag === '') && size > 0 && size < 200000) {
      const slashIdx = fullPath.indexOf('/');
      const relPath = slashIdx >= 0 ? fullPath.slice(slashIdx + 1) : fullPath;
      if (TARGET_FILES_SET.has(relPath)) {
        blobs[relPath] = tarBuf.subarray(dataStart, dataEnd).toString('utf8');
      }
    }
  }
  return blobs;
}

async function scanTarball(owner, name, branch) {
  const url = `https://codeload.github.com/${owner}/${name}/tar.gz/refs/heads/${branch}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'repoverify-indexer' },
        signal: AbortSignal.timeout(25000)
      });
      if (!res.ok) return null;
      const gzBuf = Buffer.from(await res.arrayBuffer());
      const blobs = extractTarballManifestsFromBuffer(gzBuf);
      return { blobs, truncated: false, scope: 'tarball_manifests' };
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(300);
    }
  }
  return null;
}

async function scanBlobs(owner, name, branch, headers, apiCounter) {
  const tr = await fetchGitHub(`https://api.github.com/repos/${owner}/${name}/git/trees/${branch}?recursive=1`, headers, apiCounter);
  if (!tr.ok) return null;
  const tree = await tr.json();
  if (tree.truncated) return { truncated: true };
  const names = new Set(MANIFESTS.concat(HOOK_FILES));
  const targets = (tree.tree || []).filter(t => t.type === 'blob' && names.has(t.path) && t.size < 200000);
  const blobs = {};
  for (const t of targets.slice(0, 12)) {
    const b = await fetchGitHub(`https://api.github.com/repos/${owner}/${name}/contents/${t.path}?ref=${branch}`, headers, apiCounter);
    if (!b.ok) continue;
    const j = await b.json();
    if (j.encoding === 'base64' && j.content) {
      blobs[t.path] = Buffer.from(j.content, 'base64').toString('utf8');
    }
    await sleep(90);
  }
  return { blobs, truncated: false, scope: 'manifests_api' };
}

async function scanRaw(owner, name, branch) {
  const targets = MANIFESTS.concat(HOOK_FILES);
  const blobs = {};
  await Promise.all(targets.map(async rel => {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${rel}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'repoverify-indexer' },
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        const text = await res.text();
        if (text.length < 200000) blobs[rel] = text;
      }
    } catch { /* ignore individual missing raw fetch */ }
  }));
  return { blobs, truncated: false, scope: 'raw_manifests' };
}

export async function scanStage(db, { limit = 500, fetchMode = 'tarball', delayMs = 120, dryRun = false, force = false, headers, failures, apiCounter, blobCache }) {
  const repos = force
    ? db.prepare('SELECT id, owner, name, full_name, default_branch FROM repos LIMIT ?').all(limit)
    : db.prepare(`
        SELECT r.id, r.owner, r.name, r.full_name, r.default_branch
        FROM repos r
        WHERE NOT EXISTS (
          SELECT 1 FROM behavioral_facts b WHERE b.owner = r.owner AND b.name = r.name AND b.scan_mode = 'STATIC'
        )
        LIMIT ?
      `).all(limit);
  let scanned = 0;

  const insertFact = db.prepare(`
    INSERT INTO behavioral_facts (
      owner, name, full_name, commit_sha, scan_mode, scan_scope, findings_json, scanned_at, scanner_version
    ) VALUES (?, ?, ?, ?, 'STATIC', ?, ?, ?, ?)
  `);
  const updateRef = db.prepare('UPDATE behavioral_facts SET ref = ? WHERE id = ?');
  const upsertManifest = db.prepare(`
    INSERT INTO manifest_cache (full_name, blobs_json, scope, cached_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(full_name) DO UPDATE SET
      blobs_json = excluded.blobs_json,
      scope = excluded.scope,
      cached_at = excluded.cached_at
  `);

  for (const r of repos) {
    try {
      const branch = r.default_branch || 'main';
      let got = null;
      if (fetchMode === 'raw') {
        got = await scanRaw(r.owner, r.name, branch);
      } else if (fetchMode === 'tarball') {
        got = await scanTarball(r.owner, r.name, branch);
      } else {
        got = await scanBlobs(r.owner, r.name, branch, headers, apiCounter);
      }

      if (!got || got.truncated) {
        failures.push({ stage: 'scan', repo: r.full_name, reason: 'tree_unusable_or_fetch_failed' });
        await sleep(delayMs);
        continue;
      }

      blobCache.set(r.full_name, got.blobs);
      const { findings } = scanBlobsBehavior(got.blobs, got.scope);
      const now = new Date().toISOString();

      if (!dryRun) {
        const info = insertFact.run(
          r.owner,
          r.name,
          r.full_name,
          branch,
          got.scope,
          JSON.stringify(findings),
          now,
          SCANNER_VERSION
        );
        const factId = Number(info.lastInsertRowid);
        updateRef.run(`behavioral_facts:${factId}`, factId);
        upsertManifest.run(r.full_name, JSON.stringify(got.blobs), got.scope, now);
      }
      scanned++;
    } catch (err) {
      failures.push({ stage: 'scan', repo: r.full_name, reason: err.message });
    }
    await sleep(delayMs);
  }

  return { scanned };
}

export async function osvStage(db, { limit = 500, dryRun = false, force = false, failures, blobCache }) {
  const repos = force
    ? db.prepare('SELECT owner, name, full_name FROM repos LIMIT ?').all(limit)
    : db.prepare(`
        SELECT r.owner, r.name, r.full_name
        FROM repos r
        WHERE NOT EXISTS (
          SELECT 1 FROM osv_queries o WHERE o.owner = r.owner AND o.name = r.name AND o.status IN ('queried', 'no_pinned_deps')
        )
        LIMIT ?
      `).all(limit);
  let osvOk = 0;

  const insertOsv = db.prepare(`
    INSERT INTO osv_queries (
      owner, name, full_name, ecosystem, packages, vulns_json, queried_at, ref, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of repos) {
    const fact = db.prepare(`
      SELECT id FROM behavioral_facts
      WHERE owner = ? AND name = ? AND scan_mode = 'STATIC'
      ORDER BY scanned_at DESC, id DESC LIMIT 1
    `).get(r.owner, r.name);

    if (!fact) {
      failures.push({ stage: 'osv', repo: r.full_name, reason: 'no_static_fact' });
      continue;
    }

    let blobs = blobCache.get(r.full_name);
    if (!blobs) {
      const mRow = db.prepare('SELECT blobs_json FROM manifest_cache WHERE full_name = ?').get(r.full_name);
      if (mRow) {
        try { blobs = JSON.parse(mRow.blobs_json || '{}'); } catch { blobs = {}; }
      }
    }

    const deps = extractDeps(blobs || {});
    const now = new Date().toISOString();

    if (deps.length === 0) {
      if (!dryRun) {
        const ref = `osv:${r.full_name}:none:${Date.now()}:${fact.id}`;
        insertOsv.run(r.owner, r.name, r.full_name, 'none', 0, '[]', now, ref, 'no_pinned_deps');
      }
      continue;
    }

    try {
      const allVulns = [];
      let anyQueried = false;
      for (let off = 0; off < deps.length; off += 60) {
        const chunk = deps.slice(off, off + 60);
        let res = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            res = await fetch('https://api.osv.dev/v1/querybatch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                queries: chunk.map(d => ({
                  package: { name: d.name, ecosystem: d.ecosystem },
                  version: d.version
                }))
              }),
              signal: AbortSignal.timeout(15000)
            });
            break;
          } catch (err) {
            lastErr = err;
            await sleep(400);
          }
        }
        if (!res) throw lastErr || new Error('osv_network_failed');

        if (!res.ok) {
          failures.push({ stage: 'osv', repo: r.full_name, reason: `osv_http_${res.status}` });
          if (!dryRun) {
            insertOsv.run(r.owner, r.name, r.full_name, deps[0].ecosystem, deps.length, '[]', now, `osv:${r.full_name}:err:${Date.now()}:${fact.id}`, 'error');
          }
          anyQueried = false;
          break;
        }

        anyQueried = true;
        const j = await res.json();
        for (let i = 0; i < (j.results || []).length; i++) {
          const item = j.results[i];
          if (Array.isArray(item.vulns)) {
            for (const v of item.vulns) {
              allVulns.push({ id: v.id, package: chunk[i].name, modified: v.modified || null });
            }
          }
        }
      }

      if (anyQueried) {
        if (!dryRun) {
          const ref = `osv:${r.full_name}:${fact.id}:${Date.now()}`;
          insertOsv.run(r.owner, r.name, r.full_name, deps[0].ecosystem, deps.length, JSON.stringify(allVulns), now, ref, 'queried');
        }
        osvOk++;
        await sleep(60);
      }
    } catch (err) {
      failures.push({ stage: 'osv', repo: r.full_name, reason: `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}` });
    }
  }

  return { osv_ok: osvOk };
}

if (process.argv[1] && process.argv[1].endsWith('scan-corpus.mjs')) {
  const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
  const STAGE = arg('stage') || 'all';
  const LIMIT = Number(arg('limit') || 500);
  const FETCH = arg('fetch') || 'tarball';
  const DELAY = Number(arg('delay') || 120);
  const DRY = process.argv.includes('--dry-run');
  const FORCE = process.argv.includes('--force');
  const ONLY_CENSUS = process.argv.includes('--census');

  const db = initDatabase();

  if (ONLY_CENSUS) {
    console.log(JSON.stringify(computeCensus(db), null, 2));
    closeDatabase();
    process.exit(0);
  }

  const TOKEN = loadDotEnvToken();
  if (!TOKEN && (STAGE === 'all' || STAGE === 'resolve' || FETCH === 'blobs')) {
    console.warn('[INDEXER] sans GITHUB_TOKEN : quota anonyme limité à 60 req/h.');
  }

  const headers = {
    'User-Agent': 'repoverify-indexer',
    Accept: 'application/vnd.github+json',
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
  };
  const failures = [];
  const apiCounter = { calls: 0 };
  const blobCache = new Map();
  const started = new Date().toISOString();

  const runId = DRY ? null : Number(
    db.prepare('INSERT INTO scan_runs (started_at, stage, fetch_mode) VALUES (?, ?, ?)').run(started, STAGE, FETCH).lastInsertRowid
  );

  const out = {};
  if (STAGE === 'all' || STAGE === 'resolve') {
    Object.assign(out, await resolveStage(db, { limit: LIMIT, delayMs: DELAY, dryRun: DRY, force: FORCE, headers, failures, apiCounter }));
  }
  if (STAGE === 'all' || STAGE === 'scan') {
    Object.assign(out, await scanStage(db, { limit: LIMIT, fetchMode: FETCH, delayMs: DELAY, dryRun: DRY, force: FORCE, headers, failures, apiCounter, blobCache }));
  }
  if (STAGE === 'all' || STAGE === 'osv') {
    Object.assign(out, await osvStage(db, { limit: LIMIT, dryRun: DRY, force: FORCE, failures, blobCache }));
  }

  if (runId) {
    db.prepare(`
      UPDATE scan_runs
      SET finished_at = ?, resolved = ?, ghosts = ?, dupes = ?, scanned = ?, osv_ok = ?, api_calls = ?, failures = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      out.resolved ?? 0,
      out.ghosts ?? 0,
      out.dupes ?? 0,
      out.scanned ?? 0,
      out.osv_ok ?? 0,
      apiCounter.calls,
      JSON.stringify(failures),
      runId
    );
  }

  const census = computeCensus(db);
  console.log(JSON.stringify({
    stage: STAGE,
    fetch: FETCH,
    dry: DRY,
    apiCalls: apiCounter.calls,
    ...out,
    census,
    failuresCount: failures.length,
    failures: failures.slice(0, 20)
  }, null, 2));

  closeDatabase();
  process.exit(failures.length > 0 && !out.resolved && !out.scanned && !out.osv_ok ? 1 : 0);
}
