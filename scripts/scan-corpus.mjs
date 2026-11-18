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
import { assessRepo, visibleAdvisories, decomposeReasons, checkBand } from '../src/engines/completeness.mjs';
import { expectedUpstream, identityVerdict, buildIdentityScope } from '../src/engines/identity-anchor.mjs';
import {
  DEFAULT_LOCK_CAP_BYTES,
  locateLockfiles,
  readLocks,
  blockCause,
  scopeStatement
} from '../src/engines/probe-depth.mjs';
import { readLockfile, reconcileDenominator, UNPARSEABLE_FORMATS } from '../final-correction.mjs';

const SCANNER_VERSION = 'scanner_v0.8';

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
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
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
const isExactPEP440 = v => /^\d+(?:\.\d+)*(?:(?:a|b|rc|\.post|\.dev)\d+)*$/i.test(String(v || '').trim());
const LOCAL_UV_SOURCE_RE = /^\s*source\s*=\s*\{\s*(editable|virtual|path)\b/im;

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
      if (eco === 'PyPI' && LOCAL_UV_SOURCE_RE.test(blk)) continue;
      const nm = /^name\s*=\s*"([^"]+)"/m.exec(blk);
      const vm = /^version\s*=\s*"([^"]+)"/m.exec(blk);
      const verOk = vm && (eco === 'PyPI' ? (isExactSemver(vm[1]) || isExactPEP440(vm[1])) : isExactSemver(vm[1]));
      if (nm && verOk) {
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
  return extractDepsWithCoverage(blobs).deps;
}

export function extractPrimaryPackage(blobs = {}) {
  if (typeof blobs['package.json'] === 'string') {
    try {
      const pkg = JSON.parse(blobs['package.json']);
      if (pkg?.name && typeof pkg.name === 'string') {
        return { name: pkg.name.trim(), ecosystem: 'npm' };
      }
    } catch { /* ignore */ }
  }
  if (typeof blobs['pyproject.toml'] === 'string') {
    const text = blobs['pyproject.toml'];
    const projBlock = /\[(project|tool\.poetry)\]([\s\S]*?)(\n\[|$)/i.exec(text);
    if (projBlock) {
      const nm = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(projBlock[2]);
      if (nm) return { name: nm[1].trim(), ecosystem: 'PyPI' };
    }
  }
  if (typeof blobs['Cargo.toml'] === 'string') {
    const pkgBlock = /\[package\]([\s\S]*?)(\n\[|$)/i.exec(blobs['Cargo.toml']);
    if (pkgBlock) {
      const nm = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pkgBlock[1]);
      if (nm) return { name: nm[1].trim(), ecosystem: 'crates.io' };
    }
  }
  return null;
}

export function countDeclaredDeps(blobs = {}) {
  let count = 0;
  let sawManifest = false;

  for (const [file, text] of Object.entries(blobs || {})) {
    if (typeof text !== 'string') continue;
    const base = file.split('/').pop();
    if (base === 'package.json') {
      sawManifest = true;
      try {
        const pkg = JSON.parse(text);
        count += Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
      } catch { /* ignore */ }
    } else if (base === 'requirements.txt') {
      sawManifest = true;
      for (const line of text.split(/\r?\n/)) {
        const clean = line.replace(/#.*$/, '').trim();
        if (clean && !clean.startsWith('-')) count++;
      }
    } else if (base === 'pyproject.toml') {
      sawManifest = true;
      const depsBlock = /dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text);
      if (depsBlock) {
        const items = depsBlock[1].match(/["'][^"']+["']/g);
        if (items) count += items.length;
      }
    } else if (base === 'Cargo.toml') {
      sawManifest = true;
      let inDeps = false;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) {
          inDeps = /^\[(dependencies|dev-dependencies|build-dependencies|workspace\.dependencies)\]/i.test(trimmed);
          continue;
        }
        if (inDeps && trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) count++;
      }
    } else if (base === 'go.mod') {
      sawManifest = true;
      for (const m of text.matchAll(/^\s*(?:require\s+)?([^\s/]+\/[^\s]+)\s+v\d+\.\d+\.\d+/gm)) {
        if (m[1]) count++;
      }
    }
  }
  return sawManifest ? count : null;
}

/**
 * Extrait les dépendances avec priorité lockfile ET calcule les métriques de couverture I6/I10.
 * Le dénominateur `depsResolved` provient du comptage structurel du fichier (jamais du parseur seul).
 */
export function extractDepsWithCoverage(blobs = {}) {
  const lockDepsByEco = new Map();
  const manifestDepsByEco = new Map();
  const lockReadings = [];

  for (const [file, text] of Object.entries(blobs || {})) {
    if (typeof text !== 'string') continue;
    const base = file.split('/').pop();
    if (LOCKFILES_SET.has(base) || UNPARSEABLE_FORMATS.has(base)) {
      const reading = readLockfile(base, text);
      const rec = reconcileDenominator(reading);
      lockReadings.push({ file, base, reading, reconciliation: rec });
      if (reading.parseable && reading.ecosystem && reading.acceptedEntries?.length) {
        if (!lockDepsByEco.has(reading.ecosystem)) lockDepsByEco.set(reading.ecosystem, []);
        for (const e of reading.acceptedEntries) {
          lockDepsByEco.get(reading.ecosystem).push({
            name: e.name,
            ecosystem: reading.ecosystem,
            version: e.version,
            source: base,
          });
        }
      } else if (!reading.parseable) {
        for (const d of parseLockfileDeps(base, text)) {
          if (!lockDepsByEco.has(d.ecosystem)) lockDepsByEco.set(d.ecosystem, []);
          lockDepsByEco.get(d.ecosystem).push(d);
        }
      }
    } else if (MANIFESTS.includes(base)) {
      for (const d of parseManifestDeps(base, text)) {
        if (!manifestDepsByEco.has(d.ecosystem)) manifestDepsByEco.set(d.ecosystem, []);
        manifestDepsByEco.get(d.ecosystem).push(d);
      }
    }
  }

  const combined = [];
  let lockfileUsed = null;
  let primaryEcosystem = null;
  const allEcos = new Set([...lockDepsByEco.keys(), ...manifestDepsByEco.keys()]);
  for (const eco of allEcos) {
    const lockList = lockDepsByEco.get(eco);
    const chosen = (lockList && lockList.length > 0) ? lockList : (manifestDepsByEco.get(eco) || []);
    if (!lockfileUsed && lockList && lockList.length > 0) {
      lockfileUsed = lockList[0].source || null;
    }
    if (!primaryEcosystem && chosen.length > 0) {
      primaryEcosystem = eco;
    }
    combined.push(...chosen);
  }

  const deduped = new Map();
  for (const d of combined) {
    const k = `${d.ecosystem}:${d.name}:${d.version}`;
    if (!deduped.has(k)) deduped.set(k, d);
  }
  const deps = [...deduped.values()];
  const depsDeclared = countDeclaredDeps(blobs);

  // I10 : dénominateur structurel indépendant du parseur de version
  const lockIssues = lockReadings.filter(lr => lr.reconciliation.gate !== 'RECONCILED');
  const firstUnreconciled = lockIssues[0]?.reconciliation || null;
  const structuralResolved = lockReadings.reduce((acc, lr) => acc + (lr.reading.expected ?? 0), 0);
  const depsResolved = lockfileUsed
    ? (structuralResolved > 0 ? structuralResolved : deps.length)
    : (lockIssues.length > 0 ? null : null);

  return {
    deps,
    lockfileUsed,
    primaryEcosystem: primaryEcosystem || (deps[0]?.ecosystem ?? null),
    depsDeclared,
    depsResolved,
    reconciliation: firstUnreconciled || (lockReadings.length > 0 ? { gate: 'RECONCILED', cap: null, delta: 0 } : null),
  };
}

function recordAttrition(db, { dryRun = false, cohortId = null, repoId = null, input, fromStage, toStage, reason, failures }) {
  if (failures) {
    failures.push({ repo: input, from_stage: fromStage, to_stage: toStage, reason });
  }
  if (!dryRun && db) {
    db.prepare(`
      INSERT INTO stage_attrition (cohort_id, repo_id, input, from_stage, to_stage, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(cohortId || null, repoId || null, input, fromStage, toStage, reason);
  }
}

function registerCohortMember(db, cohortId, repoId, input, dryRun = false) {
  if (!cohortId || dryRun || !db || !input) return;
  db.prepare(`
    INSERT OR IGNORE INTO cohort_members (cohort_id, repo_id, input)
    VALUES (?, ?, ?)
  `).run(cohortId, repoId || null, input);
}

/**
 * Recensement honnête avec chaîne complète + unattempted explicite + support de cohorte datée.
 */
export function computeCensus(db, cohortId = null) {
  const row = cohortId
    ? db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM repositories) AS indexed,
          (SELECT COUNT(*) FROM cohort_members WHERE cohort_id = ?) AS inputs,
          (SELECT COUNT(*) FROM cohort_members cm JOIN corpus_inputs ci ON (ci.resolved_id IS NOT NULL AND ci.resolved_id = cm.repo_id) OR LOWER(ci.input) = LOWER(cm.input) WHERE cm.cohort_id = ? AND ci.status != 'pending') AS attempted,
          (SELECT COUNT(*) FROM cohort_members cm JOIN corpus_inputs ci ON (ci.resolved_id IS NOT NULL AND ci.resolved_id = cm.repo_id) OR LOWER(ci.input) = LOWER(cm.input) WHERE cm.cohort_id = ? AND ci.status = 'pending') AS unattempted,
          (SELECT COUNT(*) FROM cohort_members cm JOIN corpus_inputs ci ON (ci.resolved_id IS NOT NULL AND ci.resolved_id = cm.repo_id) OR LOWER(ci.input) = LOWER(cm.input) WHERE cm.cohort_id = ? AND ci.status = 'ghost_404') AS ghosts,
          (SELECT COUNT(*) FROM cohort_members cm JOIN corpus_inputs ci ON (ci.resolved_id IS NOT NULL AND ci.resolved_id = cm.repo_id) OR LOWER(ci.input) = LOWER(cm.input) WHERE cm.cohort_id = ? AND ci.status = 'duplicate') AS duplicates,
          (SELECT COUNT(DISTINCT r.id) FROM cohort_members cm JOIN repos r ON r.id = cm.repo_id WHERE cm.cohort_id = ?) AS resolved,
          (SELECT COUNT(DISTINCT r.full_name) FROM cohort_members cm JOIN repos r ON r.id = cm.repo_id JOIN behavioral_facts b ON b.owner = r.owner AND b.name = r.name WHERE cm.cohort_id = ? AND b.scan_mode = 'STATIC' AND COALESCE(b.scan_scope, '') != 'no_manifest_found') AS static_scanned,
          (SELECT COUNT(DISTINCT r.full_name) FROM cohort_members cm JOIN repos r ON r.id = cm.repo_id JOIN osv_queries o ON o.owner = r.owner AND o.name = r.name WHERE cm.cohort_id = ? AND o.status = 'queried') AS osv_queried,
          (SELECT COUNT(DISTINCT r.full_name) FROM cohort_members cm JOIN repos r ON r.id = cm.repo_id JOIN osv_queries o ON o.owner = r.owner AND o.name = r.name WHERE cm.cohort_id = ? AND o.status = 'queried' AND COALESCE(o.coverage_gate, '') = 'PASS') AS coverage_pass,
          (SELECT COUNT(*) FROM (
            SELECT b.owner, b.name
            FROM cohort_members cm
            JOIN repos r ON r.id = cm.repo_id
            JOIN behavioral_facts b ON b.owner = r.owner AND b.name = r.name
            JOIN osv_queries o ON o.owner = b.owner AND o.name = b.name
            WHERE cm.cohort_id = ?
              AND b.scan_mode = 'STATIC'
              AND COALESCE(b.scan_scope, '') != 'no_manifest_found'
              AND o.status = 'queried'
              AND COALESCE(o.coverage_gate, '') = 'PASS'
              AND json_array_length(b.findings_json) = 0
              AND json_array_length(o.vulns_json) = 0
            GROUP BY b.owner, b.name
          )) AS verified_with_evidence,
          (SELECT COUNT(*) FROM stage_attrition WHERE cohort_id = ?) AS attrition_events
      `).get(cohortId, cohortId, cohortId, cohortId, cohortId, cohortId, cohortId, cohortId, cohortId, cohortId, cohortId)
    : db.prepare(`
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
          (SELECT COUNT(DISTINCT owner || '/' || name) FROM osv_queries WHERE status = 'queried' AND COALESCE(coverage_gate, '') = 'PASS') AS coverage_pass,
          (SELECT COUNT(*) FROM (
            SELECT b.owner, b.name
            FROM behavioral_facts b
            JOIN osv_queries o ON o.owner = b.owner AND o.name = b.name
            WHERE b.scan_mode = 'STATIC'
              AND COALESCE(b.scan_scope, '') != 'no_manifest_found'
              AND o.status = 'queried'
              AND COALESCE(o.coverage_gate, '') = 'PASS'
              AND json_array_length(b.findings_json) = 0
              AND json_array_length(o.vulns_json) = 0
            GROUP BY b.owner, b.name
          )) AS verified_with_evidence,
          (SELECT COUNT(*) FROM stage_attrition) AS attrition_events
      `).get();

  const passRows = cohortId
    ? db.prepare(`
        WITH latest_b AS (
          SELECT owner, name, full_name, findings_json,
                 ROW_NUMBER() OVER (PARTITION BY owner, name ORDER BY scanned_at DESC, id DESC) AS rn
          FROM behavioral_facts
          WHERE scan_mode = 'STATIC' AND COALESCE(scan_scope, '') != 'no_manifest_found'
        ),
        latest_o AS (
          SELECT owner, name, full_name, vulns_json, status, coverage_gate,
                 ROW_NUMBER() OVER (PARTITION BY owner, name ORDER BY queried_at DESC, id DESC) AS rn
          FROM osv_queries
        )
        SELECT json_array_length(b.findings_json) AS findings,
               json_array_length(o.vulns_json) AS vulns,
               (SELECT COUNT(*) FROM json_each(o.vulns_json)
                WHERE LOWER(COALESCE(json_extract(value, '$.severity'), '')) IN ('critical', 'high')) AS critical,
               json_extract(r.identity_json, '$.status') AS id_status,
               json_extract(r.identity_json, '$.anchor.url') AS anchor_url
        FROM cohort_members cm
        JOIN repos r ON r.id = cm.repo_id
        JOIN latest_b b ON b.owner = r.owner AND b.name = r.name AND b.rn = 1
        JOIN latest_o o ON o.owner = r.owner AND o.name = r.name AND o.rn = 1
        WHERE cm.cohort_id = ?
          AND o.status = 'queried'
          AND COALESCE(o.coverage_gate, '') = 'PASS'
      `).all(cohortId)
    : db.prepare(`
        WITH latest_b AS (
          SELECT owner, name, full_name, findings_json,
                 ROW_NUMBER() OVER (PARTITION BY owner, name ORDER BY scanned_at DESC, id DESC) AS rn
          FROM behavioral_facts
          WHERE scan_mode = 'STATIC' AND COALESCE(scan_scope, '') != 'no_manifest_found'
        ),
        latest_o AS (
          SELECT owner, name, full_name, vulns_json, status, coverage_gate,
                 ROW_NUMBER() OVER (PARTITION BY owner, name ORDER BY queried_at DESC, id DESC) AS rn
          FROM osv_queries
        )
        SELECT json_array_length(b.findings_json) AS findings,
               json_array_length(o.vulns_json) AS vulns,
               (SELECT COUNT(*) FROM json_each(o.vulns_json)
                WHERE LOWER(COALESCE(json_extract(value, '$.severity'), '')) IN ('critical', 'high')) AS critical,
               json_extract(r.identity_json, '$.status') AS id_status,
               json_extract(r.identity_json, '$.anchor.url') AS anchor_url
        FROM latest_b b
        JOIN latest_o o ON o.owner = b.owner AND o.name = b.name AND o.rn = 1
        LEFT JOIN repos r ON r.owner = b.owner AND r.name = b.name
        WHERE b.rn = 1 AND o.status = 'queried' AND COALESCE(o.coverage_gate, '') = 'PASS'
      `).all();

  const passBreakdown = decomposeReasons(passRows);
  const verifiedAsResolved = passBreakdown.verifiedAsResolved;
  const verifiedAsNamed = passRows.filter(p =>
    Number(p.findings || 0) === 0 &&
    Number(p.vulns || 0) === 0 &&
    (p.id_status === 'CANONICAL_MATCH' || p.id_status === 'REDIRECTED') &&
    Boolean(p.anchor_url)
  ).length;

  const probeStats = db.prepare(`
    WITH latest_p AS (
      SELECT full_name, cause, origin, gate,
             ROW_NUMBER() OVER (PARTITION BY full_name ORDER BY probed_at DESC, id DESC) AS rn
      FROM probe_outcomes
    )
    SELECT origin, cause, COUNT(*) AS cnt
    FROM latest_p
    WHERE rn = 1
    GROUP BY origin, cause
  `).all();

  const inputs = row.inputs || (cohortId ? 0 : row.indexed) || 0;
  const attempted = row.attempted || 0;
  const unattempted = row.inputs > 0 ? (row.unattempted || 0) : inputs;
  const ghosts = row.ghosts || 0;
  const duplicates = row.duplicates || 0;
  const resolved = row.resolved || 0;
  const staticScanned = row.static_scanned || 0;
  const osvQueried = row.osv_queried || 0;
  const coveragePass = row.coverage_pass || 0;
  const verifiedWithEvidence = verifiedAsResolved;

  return {
    cohortId: cohortId || null,
    inputs,
    indexed: row.indexed || 0,
    attempted,
    unattempted,
    ghosts,
    duplicates,
    resolved,
    staticScanned,
    osvQueried,
    coveragePass,
    verifiedWithEvidence,
    verifiedAsResolved,
    verifiedAsNamed,
    passBreakdown,
    probeOutcomes: probeStats,
    attritionEvents: row.attrition_events || 0,
    chainSummary: `inputs=${inputs} attempted=${attempted} unattempted=${unattempted} ghosts=${ghosts} resolved=${resolved} static=${staticScanned} osv=${osvQueried} pass=${coveragePass} verified=${verifiedAsResolved} (named=${verifiedAsNamed})`
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

export function evaluateIdentity(input, apiData, canonical, upstreamAnchor = null) {
  const key = String(input || '').toLowerCase();
  const known = KNOWN_UPSTREAMS[key] || KNOWN_UPSTREAMS[String(canonical || '').toLowerCase()] || null;
  const resolvedId = Number(apiData.id);
  const isFork = Boolean(apiData.fork);
  const expectedUpstreamId = known ? known.expected_id : null;

  let anchorVerdict = upstreamAnchor
    ? identityVerdict(upstreamAnchor, { slug: canonical, inputSlug: input, id: resolvedId })
    : { status: 'UNANCHORED', match: null, note: 'no_independent_upstream_anchor' };

  if (expectedUpstreamId && resolvedId !== expectedUpstreamId) {
    anchorVerdict = { status: 'NAMESAKE_OR_FORK', match: false, note: 'known_upstream_id_mismatch' };
  } else if (isFork) {
    anchorVerdict = { status: 'FORK', match: false, note: 'github_repo_marked_fork' };
  }

  return {
    input,
    canonical,
    resolved_id: resolvedId,
    fork: isFork,
    parent: apiData.parent?.full_name || null,
    expected_upstream_id: expectedUpstreamId,
    anchor: upstreamAnchor || null,
    match: anchorVerdict.match,
    status: anchorVerdict.status
  };
}

export async function resolveStage(db, { limit = 500, delayMs = 120, dryRun = false, force = false, cohortId = null, headers, failures, apiCounter }) {
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
    registerCohortMember(db, cohortId, null, input, dryRun);
    try {
      const r = await fetchGitHub(`https://api.github.com/repos/${input}`, headers, apiCounter);
      if (r.status === 404 || r.status === 451) {
        ghosts++;
        if (!dryRun) markInput.run('ghost_404', null, `http_${r.status}`, now, input);
        recordAttrition(db, { dryRun, cohortId, input, fromStage: 'corpus_inputs', toStage: 'resolve', reason: `http_${r.status}`, failures });
        await sleep(delayMs);
        continue;
      }
      if (!r.ok) {
        if (!dryRun) markInput.run('error', null, `http_${r.status}`, now, input);
        recordAttrition(db, { dryRun, cohortId, input, fromStage: 'corpus_inputs', toStage: 'resolve', reason: `http_${r.status}`, failures });
        await sleep(delayMs);
        continue;
      }
      const d = await r.json();
      if (!d.id) {
        ghosts++;
        if (!dryRun) markInput.run('ghost_404', null, 'missing_numeric_id', now, input);
        recordAttrition(db, { dryRun, cohortId, input, fromStage: 'corpus_inputs', toStage: 'resolve', reason: 'missing_numeric_id', failures });
        await sleep(delayMs);
        continue;
      }
      if (seen.has(d.id) || existingIds.has(d.id)) {
        dupes++;
        if (!dryRun) markInput.run('duplicate', d.id, `duplicate_of_${d.full_name}`, now, input);
        recordAttrition(db, { dryRun, cohortId, repoId: d.id, input, fromStage: 'corpus_inputs', toStage: 'resolve', reason: `duplicate_id_${d.id}`, failures });
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
          d.default_branch || 'main', typeof d.archived === 'boolean' ? (d.archived ? 1 : 0) : null, d.fork ? 1 : 0,
          d.stargazers_count || 0, d.language || null, d.license?.spdx_id ?? null,
          d.pushed_at || null, JSON.stringify(identity), now
        );
        markInput.run('resolved', d.id, null, now, input);
        if (cohortId) {
          db.prepare('UPDATE cohort_members SET repo_id = ? WHERE cohort_id = ? AND input = ?').run(d.id, cohortId, input);
        }
      }
    } catch (err) {
      if (!dryRun) markInput.run('error', null, err.message, now, input);
      recordAttrition(db, { dryRun, cohortId, input, fromStage: 'corpus_inputs', toStage: 'resolve', reason: err.message, failures });
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
      const maxSize = LOCKFILES_SET.has(relPath) ? DEFAULT_LOCK_CAP_BYTES : 200_000;
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
  const skipped = [];
  await Promise.all(ALL_TARGETS.map(async rel => {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${rel}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'repoverify-indexer' }, signal: AbortSignal.timeout(12000) });
      if (res.ok) {
        const text = await res.text();
        const maxSize = LOCKFILES_SET.has(rel) ? DEFAULT_LOCK_CAP_BYTES : 200_000;
        const sizeBytes = Buffer.byteLength(text, 'utf8');
        if (sizeBytes <= maxSize) {
          blobs[rel] = text;
        } else {
          skipped.push({ path: rel, size: sizeBytes, reason: 'over_cap' });
        }
      }
    } catch { /* ignore individual missing file */ }
  }));
  const found = Object.keys(blobs);
  return {
    blobs,
    skipped,
    truncated: null,
    scope: found.length === 0 ? 'no_manifest_found' : 'raw_manifests',
    manifestProbe: {
      probed: ALL_TARGETS,
      found,
      skipped,
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

export async function scanStage(db, { limit = 500, fetchMode = 'raw', delayMs = 120, dryRun = false, force = false, cohortId = null, repoFilter = null, headers, failures, apiCounter, blobCache }) {
  let repos;
  if (repoFilter && repoFilter.length > 0) {
    const ph = repoFilter.map(() => '?').join(',');
    repos = db.prepare(`SELECT id, owner, name, full_name, default_branch FROM repos WHERE full_name IN (${ph})`).all(...repoFilter);
  } else if (force) {
    repos = db.prepare('SELECT id, owner, name, full_name, default_branch FROM repos LIMIT ?').all(limit);
  } else {
    repos = db.prepare(`
      SELECT r.id, r.owner, r.name, r.full_name, r.default_branch
      FROM repos r
      WHERE NOT EXISTS (
        SELECT 1 FROM behavioral_facts b
        WHERE b.owner = r.owner AND b.name = r.name AND b.scan_mode = 'STATIC'
      )
      LIMIT ?
    `).all(limit);
  }

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
  const insertProbeOutcome = db.prepare(`
    INSERT INTO probe_outcomes (
      cohort_id, repo_id, full_name, consulted, truncated, locks_found_json, locks_read_json,
      cause, origin, gate, cap, scope_statement, probed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of repos) {
    registerCohortMember(db, cohortId, r.id, r.full_name, dryRun);
    try {
      const branch = r.default_branch || 'main';
      let got = null;
      if (fetchMode === 'tarball') got = await scanTarball(r.owner, r.name, branch);
      else if (fetchMode === 'blobs') got = await scanBlobs(r.owner, r.name, branch, headers, apiCounter);
      else got = await scanRaw(r.owner, r.name, branch);

      if (!got || got.truncated) {
        recordAttrition(db, { dryRun, cohortId, repoId: r.id, input: r.full_name, fromStage: 'resolve', toStage: 'scan', reason: 'tree_unusable_or_fetch_failed', failures });
        await sleep(delayMs);
        continue;
      }

      // Profondeur de sonde (§23) : si aucun lockfile lu en racine (ou fetchMode=tree), consulter git/trees
      const hasRootLock = Object.keys(got.blobs).some(k => LOCKFILES_SET.has(k.split('/').pop()));
      let probeOutcome = null;

      if (!hasRootLock || fetchMode === 'tree') {
        const located = await locateLockfiles(r.owner, r.name, branch, url => fetchGitHub(url, headers, apiCounter));
        got.manifestProbe.tree_consulted = Boolean(located.consulted);

        let readRes = { read: [], skipped: got.skipped || [] };
        if (located.consulted && !located.truncated && located.locks.length > 0) {
          const depth0 = located.locks.filter(l => l.depth === 0);
          const targetLocks = depth0.length > 0 ? depth0 : located.locks.slice(0, 4);
          readRes = await readLocks(r.owner, r.name, branch, targetLocks, DEFAULT_LOCK_CAP_BYTES);
          for (const l of readRes.read) {
            got.blobs[l.path] = l.text;
          }
          if (readRes.read.length > 0 && got.scope === 'no_manifest_found') {
            got.scope = 'tree_lockfiles';
          }
          got.manifestProbe.found = Object.keys(got.blobs);
          got.manifestProbe.skipped = readRes.skipped;
          got.manifestProbe.missing = Math.max(0, ALL_TARGETS.length - got.manifestProbe.found.length);
        }

        const existingRead = Object.keys(got.blobs)
          .filter(k => LOCKFILES_SET.has(k.split('/').pop()))
          .map(k => ({ path: k }));
        const bc = blockCause({
          located,
          read: readRes.read.length > 0 ? readRes.read : existingRead,
          skipped: readRes.skipped,
          capBytes: DEFAULT_LOCK_CAP_BYTES,
          pinnedAccepted: false,
        });
        probeOutcome = {
          consulted: located.consulted ? 1 : 0,
          truncated: located.truncated ? 1 : 0,
          locksFound: located.locks.map(l => ({ path: l.path, size: l.size, depth: l.depth })),
          locksRead: (readRes.read.length > 0 ? readRes.read : existingRead).map(l => l.path),
          cause: bc.cause,
          origin: bc.origin,
          gate: bc.cause ? (bc.origin === 'probe' ? 'INDETERMINATE' : bc.cause) : 'PASS',
          cap: bc.cap,
          scopeStatement: scopeStatement(bc),
        };
      } else {
        const readLockPaths = Object.keys(got.blobs).filter(k => LOCKFILES_SET.has(k.split('/').pop()));
        probeOutcome = {
          consulted: got.manifestProbe.tree_consulted ? 1 : 0,
          truncated: 0,
          locksFound: readLockPaths.map(p => ({ path: p, size: Buffer.byteLength(got.blobs[p], 'utf8'), depth: 0 })),
          locksRead: readLockPaths,
          cause: null,
          origin: null,
          gate: 'PASS',
          cap: 'ALLOW',
          scopeStatement: null,
        };
      }

      if (got.scope === 'no_manifest_found') {
        recordAttrition(db, { dryRun, cohortId, repoId: r.id, input: r.full_name, fromStage: 'resolve', toStage: 'scan', reason: 'no_manifest_found', failures });
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
        insertProbeOutcome.run(
          cohortId || null, r.id, r.full_name,
          probeOutcome.consulted, probeOutcome.truncated,
          JSON.stringify(probeOutcome.locksFound), JSON.stringify(probeOutcome.locksRead),
          probeOutcome.cause, probeOutcome.origin, probeOutcome.gate, probeOutcome.cap, probeOutcome.scopeStatement,
          now
        );
      }
      if (got.scope !== 'no_manifest_found') scanned++;
    } catch (err) {
      recordAttrition(db, { dryRun, cohortId, repoId: r.id, input: r.full_name, fromStage: 'resolve', toStage: 'scan', reason: err.message, failures });
    }
    await sleep(delayMs);
  }

  // Enregistrer explicitement toute attrition due au --limit restant (sauf filtre ciblé --repo)
  if (!repoFilter || repoFilter.length === 0) {
    const skippedByLimit = db.prepare(`
      SELECT r.id, r.full_name FROM repos r
      WHERE NOT EXISTS (SELECT 1 FROM behavioral_facts b WHERE b.owner = r.owner AND b.name = r.name AND b.scan_mode = 'STATIC')
    `).all();
    for (const s of skippedByLimit) {
      if (!failures.some(f => f.repo === s.full_name && f.to_stage === 'scan')) {
        recordAttrition(db, { dryRun, cohortId, repoId: s.id, input: s.full_name, fromStage: 'resolve', toStage: 'scan', reason: 'limit_cap_reached', failures });
      }
    }
  }

  return { scanned };
}

async function anchorRepoIdentity(db, r, blobs, { dryRun = false, skipAnchor = false }) {
  if (skipAnchor || !blobs) return null;
  const primaryPkg = extractPrimaryPackage(blobs);
  if (!primaryPkg) return null;

  const repoRow = db.prepare('SELECT id, full_name, fork, identity_json FROM repos WHERE id = ?').get(r.id);
  if (!repoRow) return null;
  let current = {};
  try { current = JSON.parse(repoRow.identity_json || '{}'); } catch { current = {}; }

  const expected = await expectedUpstream(primaryPkg.name, primaryPkg.ecosystem);
  const verdict = identityVerdict(expected, {
    slug: repoRow.full_name,
    inputSlug: current.input || repoRow.full_name,
    id: repoRow.id,
  });

  const updated = {
    ...current,
    canonical: repoRow.full_name,
    resolved_id: repoRow.id,
    anchor: expected,
    assurance_scope: buildIdentityScope(verdict, expected),
    status: repoRow.fork ? 'FORK' : verdict.status,
    match: repoRow.fork ? false : verdict.match,
    anchored_at: new Date().toISOString(),
  };

  if (!dryRun) {
    db.prepare('UPDATE repos SET identity_json = ? WHERE id = ?').run(JSON.stringify(updated), repoRow.id);
  }
  return updated;
}

export async function osvStage(db, { limit = 500, dryRun = false, force = false, cohortId = null, repoFilter = null, skipAnchor = false, failures, blobCache }) {
  let repos;
  if (repoFilter && repoFilter.length > 0) {
    const ph = repoFilter.map(() => '?').join(',');
    repos = db.prepare(`SELECT id, owner, name, full_name FROM repos WHERE full_name IN (${ph})`).all(...repoFilter);
  } else if (force) {
    repos = db.prepare('SELECT id, owner, name, full_name FROM repos LIMIT ?').all(limit);
  } else {
    repos = db.prepare(`
      SELECT r.id, r.owner, r.name, r.full_name
      FROM repos r
      WHERE NOT EXISTS (
        SELECT 1 FROM osv_queries o WHERE o.owner = r.owner AND o.name = r.name AND o.status = 'queried' AND o.coverage_gate IS NOT NULL
      )
      LIMIT ?
    `).all(limit);
  }
  let osvOk = 0;
  let coveragePass = 0;

  const insertOsv = db.prepare(`
    INSERT INTO osv_queries (
      owner, name, full_name, ecosystem, packages, vulns_json, queried_at, ref, status,
      deps_declared, deps_resolved, deps_queried, deps_answered, lockfile_used, coverage_gate
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of repos) {
    registerCohortMember(db, cohortId, r.id, r.full_name, dryRun);
    const fact = db.prepare(`
      SELECT id, scan_scope FROM behavioral_facts
      WHERE owner = ? AND name = ? AND scan_mode = 'STATIC'
      ORDER BY scanned_at DESC, id DESC LIMIT 1
    `).get(r.owner, r.name);

    if (!fact || fact.scan_scope === 'no_manifest_found') {
      recordAttrition(db, {
        dryRun,
        cohortId,
        repoId: r.id,
        input: r.full_name,
        fromStage: 'scan',
        toStage: 'osv',
        reason: fact ? 'no_manifest_found' : 'no_static_fact',
        failures
      });
      continue;
    }

    let blobs = blobCache.get(r.full_name);
    let manifestProbe = null;
    const mRow = db.prepare('SELECT blobs_json, manifest_probe_json FROM manifest_cache WHERE full_name = ?').get(r.full_name);
    if (!blobs && mRow) {
      try { blobs = JSON.parse(mRow.blobs_json || '{}'); } catch { blobs = {}; }
    }
    if (mRow?.manifest_probe_json) {
      try { manifestProbe = JSON.parse(mRow.manifest_probe_json); } catch { manifestProbe = null; }
    }

    await anchorRepoIdentity(db, r, blobs || {}, { dryRun, skipAnchor });

    const { deps, lockfileUsed, primaryEcosystem, depsDeclared, depsResolved, reconciliation } = extractDepsWithCoverage(blobs || {});
    const now = new Date().toISOString();

    if (deps.length === 0) {
      const comp = assessRepo({
        manifestProbe,
        lockfileUsed,
        depsDeclared,
        depsResolved,
        depsQueried: 0,
        depsAnswered: 0,
      });
      const gateName = (reconciliation && reconciliation.gate !== 'RECONCILED') ? reconciliation.gate : comp.gate.gate;
      if (!dryRun) {
        const ref = `osv:${r.full_name}:none:${Date.now()}:${fact.id}`;
        insertOsv.run(
          r.owner, r.name, r.full_name, primaryEcosystem || 'none', 0, '[]', now, ref, 'no_pinned_deps',
          depsDeclared, depsResolved, 0, 0, lockfileUsed, gateName
        );
      }
      recordAttrition(db, {
        dryRun,
        cohortId,
        repoId: r.id,
        input: r.full_name,
        fromStage: 'scan',
        toStage: 'osv',
        reason: 'no_pinned_deps',
        failures
      });
      continue;
    }

    try {
      const allVulns = [];
      let queriedCount = 0;
      let answeredCount = 0;
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
          recordAttrition(db, {
            dryRun,
            cohortId,
            repoId: r.id,
            input: r.full_name,
            fromStage: 'scan',
            toStage: 'osv',
            reason: `osv_http_${res.status}`,
            failures
          });
          if (!dryRun) {
            insertOsv.run(
              r.owner, r.name, r.full_name, deps[0].ecosystem, deps.length, '[]', now,
              `osv:${r.full_name}:err:${Date.now()}:${fact.id}`, 'error',
              depsDeclared, depsResolved, queriedCount, answeredCount, lockfileUsed, 'INCOMPLETE_QUERY'
            );
          }
          anyQueried = false;
          break;
        }
        anyQueried = true;
        queriedCount += chunk.length;
        const j = await res.json();
        const resArr = Array.isArray(j.results) ? j.results : [];
        const chunkAnswered = Math.min(chunk.length, resArr.filter(it => it && typeof it === 'object').length);
        answeredCount += chunkAnswered;
        for (let i = 0; i < resArr.length && i < chunk.length; i++) {
          const item = resArr[i];
          if (Array.isArray(item?.vulns)) {
            for (const v of item.vulns) {
              allVulns.push({ id: v.id, package: chunk[i].name, version: chunk[i].version, ecosystem: chunk[i].ecosystem, modified: v.modified || null });
            }
          }
        }
      }

      if (anyQueried) {
        const filteredVulns = visibleAdvisories(allVulns, deps.map(d => d.name));
        const comp = assessRepo({
          manifestProbe,
          lockfileUsed,
          depsDeclared,
          depsResolved,
          depsQueried: queriedCount,
          depsAnswered: answeredCount,
        });
        const gateName = (reconciliation && reconciliation.gate !== 'RECONCILED') ? reconciliation.gate : comp.gate.gate;
        if (!dryRun) {
          const ref = `osv:${r.full_name}:${fact.id}:${Date.now()}`;
          insertOsv.run(
            r.owner, r.name, r.full_name, deps[0].ecosystem, deps.length, JSON.stringify(filteredVulns), now, ref, 'queried',
            comp.coverage.deps_declared, comp.coverage.deps_resolved, comp.coverage.deps_queried, comp.coverage.deps_answered,
            comp.coverage.lockfile, gateName
          );
        }
        osvOk++;
        if (gateName === 'PASS') coveragePass++;
        else {
          recordAttrition(db, {
            dryRun,
            cohortId,
            repoId: r.id,
            input: r.full_name,
            fromStage: 'osv',
            toStage: 'verified',
            reason: `coverage_gate_${gateName}`,
            failures
          });
        }
        await sleep(60);
      }
    } catch (err) {
      recordAttrition(db, {
        dryRun,
        cohortId,
        repoId: r.id,
        input: r.full_name,
        fromStage: 'scan',
        toStage: 'osv',
        reason: err.message,
        failures
      });
    }
  }

  return { osv_ok: osvOk, coverage_pass: coveragePass };
}

if (process.argv[1] && process.argv[1].endsWith('scan-corpus.mjs')) {
  const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
  const STAGE = arg('stage') || 'all';
  const LIMIT = Number(arg('limit') || 500);
  const FETCH = arg('fetch') || 'raw';
  const DELAY = Number(arg('delay') || 120);
  const COHORT = arg('cohort') || null;
  const REPO_ARG = arg('repo') || null;
  const REPO_FILTER = REPO_ARG ? REPO_ARG.split(',').map(s => s.trim()).filter(Boolean) : null;
  const BAND_ARG = arg('expect-band') || null;
  const DRY = process.argv.includes('--dry-run');
  const FORCE = process.argv.includes('--force');
  const SKIP_ANCHOR = process.argv.includes('--skip-anchor');
  const ONLY_CENSUS = process.argv.includes('--census');

  const db = initDatabase();

  if (ONLY_CENSUS) {
    console.log(JSON.stringify(computeCensus(db, COHORT), null, 2));
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
    db.prepare('INSERT INTO scan_runs (started_at, stage, fetch_mode, cohort_id) VALUES (?, ?, ?, ?)').run(started, STAGE, FETCH, COHORT).lastInsertRowid
  );

  const out = {};
  if (STAGE === 'all' || STAGE === 'resolve') {
    Object.assign(out, await resolveStage(db, { limit: LIMIT, delayMs: DELAY, dryRun: DRY, force: FORCE, cohortId: COHORT, headers, failures, apiCounter }));
  }
  if (STAGE === 'all' || STAGE === 'scan') {
    Object.assign(out, await scanStage(db, { limit: LIMIT, fetchMode: FETCH, delayMs: DELAY, dryRun: DRY, force: FORCE, cohortId: COHORT, repoFilter: REPO_FILTER, headers, failures, apiCounter, blobCache }));
  }
  if (STAGE === 'all' || STAGE === 'osv') {
    Object.assign(out, await osvStage(db, { limit: LIMIT, dryRun: DRY, force: FORCE, cohortId: COHORT, repoFilter: REPO_FILTER, skipAnchor: SKIP_ANCHOR, failures, blobCache }));
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

  const census = computeCensus(db, COHORT);
  let sanityBand = null;
  if (BAND_ARG) {
    const [loStr, hiStr] = BAND_ARG.split(':');
    const lo = Number(loStr);
    const hi = Number(hiStr);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      sanityBand = checkBand(census.verifiedAsResolved, { lo, hi });
    }
  }

  console.log(JSON.stringify({
    stage: STAGE,
    fetch: FETCH,
    cohort: COHORT,
    repoFilter: REPO_FILTER,
    dry: DRY,
    apiCalls: apiCounter.calls,
    ...out,
    census,
    sanityBand,
    attrition: failures
  }, null, 2));

  closeDatabase();
  process.exit(sanityBand && !sanityBand.within ? 2 : 0);
}
