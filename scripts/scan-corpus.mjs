#!/usr/bin/env node
/**
 * scripts/scan-corpus.mjs — Indexeur trois étages : resolve -> scan -> osv (Runbook III)
 * Écrit des FAITS (repos, behavioral_facts, osv_queries), jamais des verdicts.
 * Lockfiles prioritaires sur manifestes, identité canonique vérifiée, aucune attrition silencieuse.
 * 100 % Natif Node.js ESM, zéro dépendance NPM.
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../src/db/database.mjs';
import { scanBlobsBehavior } from '../src/engines/behavioral-firewall.mjs';

const SCANNER_VERSION = 'scanner_v0.6';

export const MANIFESTS = [
  'package.json', 'pyproject.toml', 'requirements.txt',
  'Cargo.toml', 'go.mod', 'composer.json', 'Gemfile', 'pom.xml', 'build.gradle'
];
export const LOCKFILES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
  'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'uv.lock',
  'go.sum', 'composer.lock', 'Gemfile.lock'
];
export const HOOK_FILES = [
  'setup.py', 'scripts/setup.js', 'scripts/postinstall.js', 'bin/install.sh'
];

const LOCKFILES_SET = new Set(LOCKFILES);
const ALL_TARGETS = [...LOCKFILES, ...MANIFESTS, ...HOOK_FILES];
const TARGET_FILES_SET = new Set(ALL_TARGETS);

// Amonts attendus connus (détection slopsquatting / homonymes / forks renommés)
export const KNOWN_UPSTREAMS = Object.freeze({
  'the-pr-agent/pr-agent': { expected_id: 662766482, note: 'Codium-ai/pr-agent -> qodo-ai/pr-agent -> The-PR-Agent/pr-agent' },
  'qodo-ai/pr-agent': { expected_id: 662766482 },
  'codium-ai/pr-agent': { expected_id: 662766482 }
});

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
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const resetSec = Number(res.headers.get('x-ratelimit-reset') || 0);
    const waitMs = Math.min(60000, Math.max(1000, resetSec * 1000 - Date.now()));
    console.warn(`[INDEXER] Rate-limit GitHub atteint : pause ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
    return fetchGitHub(url, headers, apiCounter);
  }
  return res;
}

const isExactSemver = v => /^\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$/.test(String(v || '').trim());

function parseLockfileDeps(base, text) {
  const deps = [];
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') {
    try {
      const lock = JSON.parse(text);
      if (lock.packages && typeof lock.packages === 'object') {
        for (const [pkgPath, meta] of Object.entries(lock.packages)) {
          if (!pkgPath || !meta?.version) continue;
          const idx = pkgPath.lastIndexOf('node_modules/');
          if (idx >= 0) {
            const name = pkgPath.slice(idx + 'node_modules/'.length);
            if (name && isExactSemver(meta.version)) {
              deps.push({ name, ecosystem: 'npm', version: meta.version, source: base });
            }
          }
        }
      } else if (lock.dependencies && typeof lock.dependencies === 'object') {
        for (const [name, meta] of Object.entries(lock.dependencies)) {
          if (meta?.version && isExactSemver(meta.version)) {
            deps.push({ name, ecosystem: 'npm', version: meta.version, source: base });
          }
        }
      }
    } catch { /* invalid lock JSON */ }
  } else if (base === 'yarn.lock') {
    let curNames = [];
    for (const line of text.split(/\r?\n/)) {
      if (line && !line.startsWith(' ') && !line.startsWith('#') && line.endsWith(':')) {
        curNames = line.slice(0, -1).split(',').map(s => {
          const clean = s.trim().replace(/^["']|["']$/g, '');
          const atIdx = clean.lastIndexOf('@');
          return atIdx > 0 ? clean.slice(0, atIdx) : clean;
        }).filter(Boolean);
      } else if (curNames.length > 0) {
        const vm = /^\s+version\s+"([^"]+)"/.exec(line) || /^\s+version:\s+([^\s]+)/.exec(line);
        if (vm && isExactSemver(vm[1])) {
          for (const n of curNames) {
            deps.push({ name: n, ecosystem: 'npm', version: vm[1], source: base });
          }
          curNames = [];
        }
      }
    }
  } else if (base === 'pnpm-lock.yaml') {
    for (const m of text.matchAll(/^\s{2,4}'?\/?(@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)@(\d+\.\d+\.\d+[^(':\s]*)/gm)) {
      deps.push({ name: m[1], ecosystem: 'npm', version: m[2], source: base });
    }
  } else if (base === 'Cargo.lock' || base === 'poetry.lock' || base === 'uv.lock') {
    const eco = base === 'Cargo.lock' ? 'crates.io' : 'PyPI';
    const blocks = text.split(/\[\[package\]\]/i);
    for (const blk of blocks.slice(1)) {
      const nm = /^name\s*=\s*"([^"]+)"/m.exec(blk);
      const vm = /^version\s*=\s*"([^"]+)"/m.exec(blk);
      if (nm && vm && isExactSemver(vm[1])) {
        deps.push({ name: nm[1], ecosystem: eco, version: vm[1], source: base });
      }
    }
  } else if (base === 'go.sum') {
    for (const m of text.matchAll(/^([^\s/]+\/[^\s]+)\s+v(\d+\.\d+\.\d+[^\s/]*)/gm)) {
      deps.push({ name: m[1], ecosystem: 'Go', version: m[2].replace(/\/go\.mod$/, ''), source: base });
    }
  } else if (base === 'composer.lock') {
    try {
      const lock = JSON.parse(text);
      for (const pkg of [...(lock.packages || []), ...(lock['packages-dev'] || [])]) {
        const ver = String(pkg?.version || '').replace(/^v/, '');
        if (pkg?.name && isExactSemver(ver)) {
          deps.push({ name: pkg.name, ecosystem: 'Packagist', version: ver, source: base });
        }
      }
    } catch { /* ignore */ }
  } else if (base === 'Gemfile.lock') {
    for (const m of text.matchAll(/^\s{4}([A-Za-z0-9._-]+)\s+\((\d+\.\d+\.\d+[^)]*)\)/gm)) {
      deps.push({ name: m[1], ecosystem: 'RubyGems', version: m[2], source: base });
    }
  }
  return deps;
}

function parseManifestDeps(base, text) {
  const deps = [];
  if (base === 'package.json') {
    try {
      const pkg = JSON.parse(text);
      for (const [name, ver] of Object.entries({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) {
        const clean = String(ver).trim();
        // Exiger version exacte (sans plage ^ ou ~ ni *) quand aucun lockfile n'est présent
        if (isExactSemver(clean)) {
          deps.push({ name, ecosystem: 'npm', version: clean, source: base });
        }
      }
    } catch { /* ignore */ }
  } else if (base === 'requirements.txt') {
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9._-]+)\s*==\s*([0-9][^\s;#]*)/.exec(line);
      if (m && isExactSemver(m[2])) deps.push({ name: m[1], ecosystem: 'PyPI', version: m[2], source: base });
    }
  } else if (base === 'pyproject.toml') {
    for (const m of text.matchAll(/["']([A-Za-z0-9._-]+)\s*==\s*([0-9][^"'\s;,]*)["']/g)) {
      if (isExactSemver(m[2])) deps.push({ name: m[1], ecosystem: 'PyPI', version: m[2], source: base });
    }
  } else if (base === 'Cargo.toml') {
    let inDepsSection = false;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        inDepsSection = /^\[(dependencies|dev-dependencies|build-dependencies|workspace\.dependencies)\]/i.test(trimmed);
        continue;
      }
      if (!inDepsSection || !trimmed || trimmed.startsWith('#')) continue;
      // Exiger 3 composants x.y.z pour ne jamais interroger OSV sur une plage "0.3"
      const m = /^([A-Za-z0-9_-]+)\s*=\s*"=?(\d+\.\d+\.\d+[^"]*)"/.exec(trimmed);
      if (m) deps.push({ name: m[1], ecosystem: 'crates.io', version: m[2], source: base });
    }
  } else if (base === 'go.mod') {
    for (const m of text.matchAll(/^\s*([^\s/]+\/[^\s]+)\s+v(\d+\.\d+\.\d+[^\s/]*)/gm)) {
      deps.push({ name: m[1], ecosystem: 'Go', version: m[2], source: base });
    }
  }
  return deps;
}

/**
 * Extrait les dépendances exactement épinglées (x.y.z).
 * Priorité absolue aux lockfiles ; les manifestes ne servent qu'en repli par écosystème.
 */
export function extractDeps(blobs = {}) {
  const lockDepsByEco = new Map();
  const manifestDepsByEco = new Map();

  for (const [file, text] of Object.entries(blobs || {})) {
    if (typeof text !== 'string') continue;
    const base = file.split('/').pop();
    if (LOCKFILES_SET.has(base)) {
      for (const d of parseLockfileDeps(base, text)) {
        if (!lockDepsByEco.has(d.ecosystem)) lockDepsByEco.set(d.ecosystem, []);
        lockDepsByEco.get(d.ecosystem).push(d);
      }
    } else if (MANIFESTS.includes(base)) {
      for (const d of parseManifestDeps(base, text)) {
        if (!manifestDepsByEco.has(d.ecosystem)) manifestDepsByEco.set(d.ecosystem, []);
        manifestDepsByEco.get(d.ecosystem).push(d);
      }
    }
  }

  const combined = [];
  const allEcos = new Set([...lockDepsByEco.keys(), ...manifestDepsByEco.keys()]);
  for (const eco of allEcos) {
    const lockList = lockDepsByEco.get(eco);
    const chosen = (lockList && lockList.length > 0) ? lockList : (manifestDepsByEco.get(eco) || []);
    combined.push(...chosen);
  }

  const deduped = new Map();
  for (const d of combined) {
    const k = `${d.ecosystem}:${d.name}:${d.version}`;
    if (!deduped.has(k)) deduped.set(k, d);
  }
  return [...deduped.values()];
}

/**
 * Recensement honnête avec chaîne complète + unattempted explicite (Runbook III & revue)
 */
export function computeCensus(db) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM repositories) AS indexed,
      (SELECT COUNT(*) FROM corpus_inputs) AS inputs,
      (SELECT COUNT(*) FROM corpus_inputs WHERE status != 'pending') AS attempted,
      (SELECT COUNT(*) FROM corpus_inputs WHERE status = 'pending') AS unattempted,
      (SELECT COUNT(*) FROM corpus_inputs WHERE status = 'ghost_404') AS ghosts,
      (SELECT COUNT(*) FROM corpus_inputs WHERE status = 'duplicate') AS duplicates,
      (SELECT COUNT(*) FROM repos) AS resolved,
      (SELECT COUNT(DISTINCT owner || '/' || name) FROM behavioral_facts WHERE scan_mode = 'STATIC' AND COALESCE(scan_scope, '') != 'no_manifest_found') AS static_scanned,
      (SELECT COUNT(DISTINCT owner || '/' || name) FROM osv_queries WHERE status = 'queried') AS osv_queried,
      (SELECT COUNT(*) FROM (
        SELECT b.owner, b.name
        FROM behavioral_facts b
        JOIN osv_queries o ON o.owner = b.owner AND o.name = b.name
        WHERE b.scan_mode = 'STATIC'
          AND COALESCE(b.scan_scope, '') != 'no_manifest_found'
          AND o.status = 'queried'
          AND json_array_length(b.findings_json) = 0
          AND json_array_length(o.vulns_json) = 0
        GROUP BY b.owner, b.name
      )) AS verified_with_evidence
  `).get();

  const inputs = row.inputs || row.indexed || 0;
  const attempted = row.attempted || 0;
  const unattempted = row.inputs > 0 ? (row.unattempted || 0) : inputs;
  const ghosts = row.ghosts || 0;
  const duplicates = row.duplicates || 0;
  const resolved = row.resolved || 0;
  const staticScanned = row.static_scanned || 0;
  const osvQueried = row.osv_queried || 0;
  const verifiedWithEvidence = row.verified_with_evidence || 0;

  return {
    inputs,
    indexed: row.indexed || 0,
    attempted,
    unattempted,
    ghosts,
    duplicates,
    resolved,
    staticScanned,
    osvQueried,
    verifiedWithEvidence,
    chainSummary: `inputs=${inputs} attempted=${attempted} unattempted=${unattempted} ghosts=${ghosts} resolved=${resolved} static=${staticScanned} osv=${osvQueried} verified=${verifiedWithEvidence}`
  };
}

function seedCorpusInputsIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM corpus_inputs').get().cnt;
  if (count === 0) {
    db.exec(`
      INSERT OR IGNORE INTO corpus_inputs (input, status, added_at)
      SELECT full_name, 'pending', datetime('now') FROM repositories;
    `);
  }
}

export function evaluateIdentity(input, apiData, canonical) {
  const key = String(input || '').toLowerCase();
  const known = KNOWN_UPSTREAMS[key] || KNOWN_UPSTREAMS[String(canonical || '').toLowerCase()] || null;
  const resolvedId = Number(apiData.id);
  const isFork = Boolean(apiData.fork);
  const expectedUpstreamId = known ? known.expected_id : null;
  let match = true;
  let status = 'CANONICAL_MATCH';

  if (expectedUpstreamId && resolvedId !== expectedUpstreamId) {
    match = false;
    status = 'NAMESAKE_OR_FORK';
  } else if (isFork) {
    match = false;
    status = 'FORK';
  } else if (input.toLowerCase() !== String(canonical || '').toLowerCase()) {
    status = 'REDIRECTED';
  }

  return {
    input,
    canonical,
    resolved_id: resolvedId,
    fork: isFork,
    parent: apiData.parent?.full_name || null,
    expected_upstream_id: expectedUpstreamId,
    match,
    status
  };
}

export async function resolveStage(db, { limit = 500, delayMs = 120, dryRun = false, force = false, headers, failures, apiCounter }) {
  seedCorpusInputsIfEmpty(db);
  const inputs = force
    ? db.prepare('SELECT input FROM corpus_inputs LIMIT ?').all(limit)
    : db.prepare("SELECT input FROM corpus_inputs WHERE status = 'pending' LIMIT ?").all(limit);

  const existingIds = new Set(db.prepare('SELECT id FROM repos').all().map(r => r.id));
  const seen = new Map();
  let ghosts = 0;
  let dupes = 0;

  const markInput = db.prepare(`
    UPDATE corpus_inputs
    SET status = ?, resolved_id = ?, last_error = ?, attempted_at = ?
    WHERE input = ?
  `);

  const upsertRepo = db.prepare(`
    INSERT INTO repos (id, owner, name, full_name, default_branch, archived, fork, stars, language, license, pushed_at, identity_json, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      identity_json = excluded.identity_json,
      resolved_at = excluded.resolved_at
  `);

  for (const { input } of inputs) {
    const now = new Date().toISOString();
    try {
      const r = await fetchGitHub(`https://api.github.com/repos/${input}`, headers, apiCounter);
      if (r.status === 404 || r.status === 451) {
        ghosts++;
        if (!dryRun) markInput.run('ghost_404', null, `http_${r.status}`, now, input);
        failures.push({ repo: input, from_stage: 'corpus_inputs', to_stage: 'resolve', reason: `http_${r.status}` });
        await sleep(delayMs);
        continue;
      }
      if (!r.ok) {
        if (!dryRun) markInput.run('error', null, `http_${r.status}`, now, input);
        failures.push({ repo: input, from_stage: 'corpus_inputs', to_stage: 'resolve', reason: `http_${r.status}` });
        await sleep(delayMs);
        continue;
      }
      const d = await r.json();
      if (!d.id) {
        ghosts++;
        if (!dryRun) markInput.run('ghost_404', null, 'missing_numeric_id', now, input);
        failures.push({ repo: input, from_stage: 'corpus_inputs', to_stage: 'resolve', reason: 'missing_numeric_id' });
        await sleep(delayMs);
        continue;
      }
      if (seen.has(d.id) || existingIds.has(d.id)) {
        dupes++;
        if (!dryRun) markInput.run('duplicate', d.id, `duplicate_of_${d.full_name}`, now, input);
        failures.push({ repo: input, from_stage: 'corpus_inputs', to_stage: 'resolve', reason: `duplicate_id_${d.id}` });
        await sleep(delayMs);
        continue;
      }
      seen.set(d.id, true);
      existingIds.add(d.id);

      const canonical = d.full_name || input;
      const identity = evaluateIdentity(input, d, canonical);
      const [canonOwner, canonName] = canonical.split('/');
      if (!dryRun && canonOwner && canonName) {
        upsertRepo.run(
          d.id, canonOwner, canonName, canonical,
          d.default_branch || 'main', d.archived ? 1 : 0, d.fork ? 1 : 0,
          d.stargazers_count || 0, d.language || null, d.license?.spdx_id ?? null,
          d.pushed_at || null, JSON.stringify(identity), now
        );
        markInput.run('resolved', d.id, null, now, input);
      }
    } catch (err) {
      if (!dryRun) markInput.run('error', null, err.message, now, input);
      failures.push({ repo: input, from_stage: 'corpus_inputs', to_stage: 'resolve', reason: err.message });
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
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (!Number.isFinite(size) || size < 0 || dataEnd > tarBuf.length) break;
    if (typeFlag === 'L') {
      nextLongName = tarBuf.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/, '');
      continue;
    }

    const fullPath = nextLongName || (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
    nextLongName = null;

    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      const slashIdx = fullPath.indexOf('/');
      const relPath = slashIdx >= 0 ? fullPath.slice(slashIdx + 1) : fullPath;
      const maxSize = LOCKFILES_SET.has(relPath) ? 2_000_000 : 200_000;
      if (size > 0 && size < maxSize && TARGET_FILES_SET.has(relPath)) {
        blobs[relPath] = tarBuf.subarray(dataStart, dataEnd).toString('utf8');
      }
    }
  }
  return blobs;
}

async function scanTarball(owner, name, branch) {
  const url = `https://codeload.github.com/${owner}/${name}/tar.gz/refs/heads/${branch}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'repoverify-indexer' }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) return null;
  const blobs = extractTarballManifestsFromBuffer(Buffer.from(await res.arrayBuffer()));
  return {
    blobs,
    truncated: false,
    scope: Object.keys(blobs).length === 0 ? 'no_manifest_found' : 'tarball_manifests',
    manifestProbe: {
      probed: ALL_TARGETS,
      found: Object.keys(blobs),
      missing: ALL_TARGETS.length - Object.keys(blobs).length,
      tree_consulted: true
    }
  };
}

async function scanRaw(owner, name, branch) {
  const blobs = {};
  await Promise.all(ALL_TARGETS.map(async rel => {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${rel}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'repoverify-indexer' }, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const text = await res.text();
        const maxSize = LOCKFILES_SET.has(rel) ? 2_000_000 : 200_000;
        if (text.length < maxSize) blobs[rel] = text;
      }
    } catch { /* ignore individual missing file */ }
  }));
  const found = Object.keys(blobs);
  return {
    blobs,
    truncated: false,
    scope: found.length === 0 ? 'no_manifest_found' : 'raw_manifests',
    manifestProbe: {
      probed: ALL_TARGETS,
      found,
      missing: ALL_TARGETS.length - found.length,
      tree_consulted: false
    }
  };
}

async function scanBlobs(owner, name, branch, headers, apiCounter) {
  const tr = await fetchGitHub(`https://api.github.com/repos/${owner}/${name}/git/trees/${branch}?recursive=1`, headers, apiCounter);
  if (!tr.ok) return null;
  const tree = await tr.json();
  if (tree.truncated) return { truncated: true };
  const targets = (tree.tree || []).filter(t => t.type === 'blob' && TARGET_FILES_SET.has(t.path) && t.size < 200000);
  const blobs = {};
  for (const t of targets.slice(0, 16)) {
    const b = await fetchGitHub(`https://api.github.com/repos/${owner}/${name}/contents/${t.path}?ref=${branch}`, headers, apiCounter);
    if (!b.ok) continue;
    const j = await b.json();
    if (j.encoding === 'base64' && j.content) {
      blobs[t.path] = Buffer.from(j.content, 'base64').toString('utf8');
    }
    await sleep(90);
  }
  const found = Object.keys(blobs);
  return {
    blobs,
    truncated: false,
    scope: found.length === 0 ? 'no_manifest_found' : 'manifests_api',
    manifestProbe: {
      probed: targets.map(t => t.path),
      found,
      missing: Math.max(0, targets.length - found.length),
      tree_consulted: true
    }
  };
}

export async function scanStage(db, { limit = 500, fetchMode = 'raw', delayMs = 120, dryRun = false, force = false, headers, failures, apiCounter, blobCache }) {
  const repos = force
    ? db.prepare('SELECT id, owner, name, full_name, default_branch FROM repos LIMIT ?').all(limit)
    : db.prepare(`
        SELECT r.id, r.owner, r.name, r.full_name, r.default_branch
        FROM repos r
        WHERE NOT EXISTS (
          SELECT 1 FROM behavioral_facts b
          WHERE b.owner = r.owner AND b.name = r.name AND b.scan_mode = 'STATIC'
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
    INSERT INTO manifest_cache (full_name, blobs_json, scope, manifest_probe_json, cached_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(full_name) DO UPDATE SET
      blobs_json = excluded.blobs_json,
      scope = excluded.scope,
      manifest_probe_json = excluded.manifest_probe_json,
      cached_at = excluded.cached_at
  `);

  for (const r of repos) {
    try {
      const branch = r.default_branch || 'main';
      let got = null;
      if (fetchMode === 'raw') got = await scanRaw(r.owner, r.name, branch);
      else if (fetchMode === 'tarball') got = await scanTarball(r.owner, r.name, branch);
      else got = await scanBlobs(r.owner, r.name, branch, headers, apiCounter);

      if (!got || got.truncated) {
        failures.push({ repo: r.full_name, from_stage: 'resolve', to_stage: 'scan', reason: 'tree_unusable_or_fetch_failed' });
        await sleep(delayMs);
        continue;
      }

      if (got.scope === 'no_manifest_found') {
        failures.push({ repo: r.full_name, from_stage: 'resolve', to_stage: 'scan', reason: 'no_manifest_found' });
      }

      blobCache.set(r.full_name, got.blobs);
      const { findings } = scanBlobsBehavior(got.blobs, got.scope);
      const now = new Date().toISOString();

      if (!dryRun) {
        const info = insertFact.run(
          r.owner, r.name, r.full_name, branch, got.scope, JSON.stringify(findings), now, SCANNER_VERSION
        );
        const factId = Number(info.lastInsertRowid);
        updateRef.run(`behavioral_facts:${factId}`, factId);
        upsertManifest.run(r.full_name, JSON.stringify(got.blobs), got.scope, JSON.stringify(got.manifestProbe), now);
      }
      if (got.scope !== 'no_manifest_found') scanned++;
    } catch (err) {
      failures.push({ repo: r.full_name, from_stage: 'resolve', to_stage: 'scan', reason: err.message });
    }
    await sleep(delayMs);
  }

  // Enregistrer explicitement toute attrition due au --limit restant
  const skippedByLimit = db.prepare(`
    SELECT r.full_name FROM repos r
    WHERE NOT EXISTS (SELECT 1 FROM behavioral_facts b WHERE b.owner = r.owner AND b.name = r.name AND b.scan_mode = 'STATIC')
  `).all();
  for (const s of skippedByLimit) {
    if (!failures.some(f => f.repo === s.full_name && f.to_stage === 'scan')) {
      failures.push({ repo: s.full_name, from_stage: 'resolve', to_stage: 'scan', reason: 'limit_cap_reached' });
    }
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
          SELECT 1 FROM osv_queries o WHERE o.owner = r.owner AND o.name = r.name AND o.status = 'queried'
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
      SELECT id, scan_scope FROM behavioral_facts
      WHERE owner = ? AND name = ? AND scan_mode = 'STATIC'
      ORDER BY scanned_at DESC, id DESC LIMIT 1
    `).get(r.owner, r.name);

    if (!fact || fact.scan_scope === 'no_manifest_found') {
      failures.push({ repo: r.full_name, from_stage: 'scan', to_stage: 'osv', reason: fact ? 'no_manifest_found' : 'no_static_fact' });
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
      failures.push({ repo: r.full_name, from_stage: 'scan', to_stage: 'osv', reason: 'no_pinned_deps' });
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
          failures.push({ repo: r.full_name, from_stage: 'scan', to_stage: 'osv', reason: `osv_http_${res.status}` });
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
              allVulns.push({ id: v.id, package: chunk[i].name, version: chunk[i].version, ecosystem: chunk[i].ecosystem, modified: v.modified || null });
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
      failures.push({ repo: r.full_name, from_stage: 'scan', to_stage: 'osv', reason: err.message });
    }
  }

  return { osv_ok: osvOk };
}

if (process.argv[1] && process.argv[1].endsWith('scan-corpus.mjs')) {
  const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
  const STAGE = arg('stage') || 'all';
  const LIMIT = Number(arg('limit') || 500);
  const FETCH = arg('fetch') || 'raw';
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
    attrition: failures
  }, null, 2));

  closeDatabase();
  process.exit(0);
}
