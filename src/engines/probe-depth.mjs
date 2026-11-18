/**
 * Profondeur de sonde & distinction stricte origine sonde ('probe') vs dépôt ('repo').
 *
 * Un verdict négatif (NO_LOCKFILE, TREE_TRUNCATED, LOCKFILE_OVER_CAP, ECO_LOCK_MISMATCH)
 * doit porter sa cause exacte. Une limite de la sonde ne doit JAMAIS être publiée comme
 * une propriété du dépôt.
 */

export const LOCKS = Object.freeze([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'pdm.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',
  'mix.lock',
  'gradle.lockfile',
]);

export const PINNED = Object.freeze([
  'requirements.txt',
  'requirements_versions.txt',
  'constraints.txt',
]);

export const ECO_LOCKS = Object.freeze({
  npm: ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'],
  PyPI: ['poetry.lock', 'uv.lock', 'pdm.lock'],
  'crates.io': ['Cargo.lock'],
  Go: ['go.sum'],
  Packagist: ['composer.lock'],
  RubyGems: ['Gemfile.lock'],
});

export const DEFAULT_LOCK_CAP_BYTES = 20 * 1024 * 1024; // 20 Mo

/**
 * Un seul appel git/trees récursif localise tous les lockfiles et manifests,
 * y compris les fichiers volumineux et les sous-répertoires.
 */
export async function locateLockfiles(owner, name, branch, ghFetch) {
  const url = `https://api.github.com/repos/${owner}/${name}/git/trees/${branch}?recursive=1`;
  let res;
  try {
    res = await ghFetch(url);
  } catch (err) {
    return { consulted: false, truncated: false, reason: `tree_error:${err?.name || 'Error'}`, locks: [], pinned: [] };
  }
  if (!res || !res.ok) {
    return { consulted: false, truncated: false, reason: `tree_http_${res?.status ?? 'err'}`, locks: [], pinned: [] };
  }
  const tree = await res.json();
  if (tree?.truncated) {
    return { consulted: true, truncated: true, locks: [], pinned: [], reason: 'tree_truncated' };
  }

  const locks = [];
  const pinned = [];
  for (const entry of tree?.tree || []) {
    if (entry?.type !== 'blob' || typeof entry.path !== 'string') continue;
    const base = entry.path.split('/').pop();
    const depth = entry.path.split('/').length - 1;
    const size = Number(entry.size || 0);
    if (LOCKS.includes(base)) {
      locks.push({ path: entry.path, size, depth });
    }
    if (PINNED.includes(base)) {
      pinned.push({ path: entry.path, size, depth });
    }
  }

  locks.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  pinned.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  return { consulted: true, truncated: false, locks, pinned };
}

/**
 * Lecture explicite des lockfiles localisés avec plafond en octets.
 * Tout refus (taille > capBytes ou HTTP non-200) est enregistré comme une donnée.
 */
export async function readLocks(owner, name, branch, locks, capBytes = DEFAULT_LOCK_CAP_BYTES, rawFetch = fetch) {
  const read = [];
  const skipped = [];

  for (const l of locks || []) {
    if (Number.isFinite(l.size) && l.size > capBytes) {
      skipped.push({ ...l, reason: 'over_cap' });
      continue;
    }
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${l.path}`;
    try {
      const res = await rawFetch(url, {
        headers: { 'User-Agent': 'repoverify-indexer' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        skipped.push({ ...l, reason: `fetch_http_${res.status}` });
        continue;
      }
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > capBytes) {
        skipped.push({ ...l, reason: 'over_cap' });
        continue;
      }
      read.push({ ...l, text });
    } catch (err) {
      skipped.push({ ...l, reason: `fetch_error:${err?.name || 'Error'}` });
    }
  }

  return { read, skipped };
}

/**
 * Attribue explicitement la cause et l'origine (`probe` vs `repo`) d'un défaut de lockfile.
 */
export function blockCause({
  located,
  read = [],
  skipped = [],
  capBytes = DEFAULT_LOCK_CAP_BYTES,
  pinnedAccepted = false,
  ecoAllowed = null,
} = {}) {
  if (!located || !located.consulted) {
    return { cause: 'TREE_UNAVAILABLE', origin: 'probe', cap: 'INDETERMINATE' };
  }
  if (located.truncated) {
    return { cause: 'TREE_TRUNCATED', origin: 'probe', cap: 'INDETERMINATE' };
  }

  const locks = Array.isArray(located.locks) ? located.locks : [];
  const pinned = Array.isArray(located.pinned) ? located.pinned : [];

  if (locks.length === 0) {
    if (pinned.length > 0 && pinnedAccepted) {
      return { cause: 'DIRECT_PINS_ONLY', origin: 'repo', cap: 'WARN' };
    }
    return { cause: 'NO_LOCKFILE', origin: 'repo', cap: 'WARN' };
  }

  if (Array.isArray(ecoAllowed) && ecoAllowed.length > 0) {
    const ecoBlocked = locks.filter(l => !ecoAllowed.includes(l.path.split('/').pop()));
    if (ecoBlocked.length === locks.length) {
      return {
        cause: 'ECO_LOCK_MISMATCH',
        origin: 'probe',
        cap: 'INDETERMINATE',
        paths: ecoBlocked.map(l => l.path),
      };
    }
  }

  if (!Array.isArray(read) || read.length === 0) {
    const over = (skipped || []).filter(s => s.reason === 'over_cap');
    if (over.length > 0) {
      return {
        cause: 'LOCKFILE_OVER_CAP',
        origin: 'probe',
        cap: 'INDETERMINATE',
        observed: over.map(o => ({ path: o.path, size: o.size, cap: capBytes })),
      };
    }
    if (locks.some(l => (l.size ?? 0) > capBytes)) {
      return {
        cause: 'LOCKFILE_OVER_CAP',
        origin: 'probe',
        cap: 'INDETERMINATE',
        observed: locks.filter(l => (l.size ?? 0) > capBytes).map(o => ({ path: o.path, size: o.size, cap: capBytes })),
      };
    }
    return {
      cause: 'LOCKFILE_UNREAD',
      origin: 'probe',
      cap: 'INDETERMINATE',
      skipped: skipped || [],
    };
  }

  return { cause: null, origin: null, cap: 'ALLOW' };
}

/**
 * Énoncé de portée pour publication : une limite d'examen n'est jamais une propriété du dépôt.
 */
export function scopeStatement(b) {
  if (!b) return null;
  if (b.origin === 'repo') {
    return b.cause === 'DIRECT_PINS_ONLY'
      ? 'Le dépôt épingle des dépendances directes sans fermeture transitive (lockfile absent).'
      : 'Le dépôt ne fournit pas de fermeture transitive épinglée.';
  }
  if (b.origin === 'probe') {
    return `Examen incomplet : ${b.cause}. Aucune conclusion sur la présence d'un lockfile.`;
  }
  return null;
}
