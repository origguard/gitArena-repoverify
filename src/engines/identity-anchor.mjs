/**
 * Ancrage d'identité amont via registres de paquets indépendants (npm, PyPI, crates.io).
 *
 * Règle fondamentale : ne jamais comparer un nom de dépôt GitHub à lui-même via
 * l'API GitHub pour prouver qu'un dépôt est l'upstream légitime d'un paquet.
 * La preuve doit venir d'un registre tiers indépendant.
 */

const GITHUB_URL_RE = /(?:https?:\/\/|git\+https?:\/\/|git:\/\/|ssh:\/\/git@|git@)github\.com[:/]([^/\s?#]+)\/([^/\s?#]+)/i;

/**
 * Extrait un slug `owner/name` normalisé en minuscules depuis une URL GitHub brute.
 */
export function cleanGitUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  const match = trimmed.match(GITHUB_URL_RE);
  if (match) {
    const owner = match[1].trim().toLowerCase();
    const repo = match[2].replace(/\.git$/i, '').replace(/\/+$/, '').trim().toLowerCase();
    if (owner && repo) return `${owner}/${repo}`;
  }
  // Slug direct `owner/repo`
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(trimmed)) {
    return trimmed.replace(/\.git$/i, '').toLowerCase();
  }
  return null;
}

function extractGithubFromPyPIInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const urls = info.project_urls && typeof info.project_urls === 'object'
    ? info.project_urls
    : {};
  const priorityKeys = ['Source', 'Source Code', 'Repository', 'Code', 'GitHub', 'Homepage'];
  for (const key of priorityKeys) {
    for (const [k, v] of Object.entries(urls)) {
      if (k.toLowerCase() === key.toLowerCase() && typeof v === 'string') {
        const slug = cleanGitUrl(v);
        if (slug) return v;
      }
    }
  }
  for (const v of Object.values(urls)) {
    if (typeof v === 'string') {
      const slug = cleanGitUrl(v);
      if (slug) return v;
    }
  }
  if (typeof info.home_page === 'string' && cleanGitUrl(info.home_page)) {
    return info.home_page;
  }
  return null;
}

/**
 * Interroge le registre indépendant correspondant à l'écosystème pour obtenir
 * l'URL GitHub amont déclarée par le mainteneur du paquet.
 */
export async function expectedUpstream(pkg, ecosystem, { timeoutMs = 6000, fetchFn = fetch } = {}) {
  const pkgName = String(pkg || '').trim();
  const eco = String(ecosystem || '').trim().toLowerCase();
  if (!pkgName) {
    return { source: null, ecosystem: eco || null, package: pkgName, url: null, rawUrl: null, reason: 'missing_package_name' };
  }

  let endpoint = null;
  let source = null;
  if (eco === 'npm') {
    source = 'registry.npmjs.org';
    endpoint = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}`;
  } else if (eco === 'pypi') {
    source = 'pypi.org';
    endpoint = `https://pypi.org/pypi/${encodeURIComponent(pkgName)}/json`;
  } else if (eco === 'crates.io' || eco === 'cargo' || eco === 'rust') {
    source = 'crates.io';
    endpoint = `https://crates.io/api/v1/crates/${encodeURIComponent(pkgName)}`;
  } else {
    return { source: null, ecosystem: eco || null, package: pkgName, url: null, rawUrl: null, reason: `unsupported_ecosystem:${eco || 'none'}` };
  }

  try {
    const res = await fetchFn(endpoint, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'RepoVerify-IdentityAnchor/1.0 (+local-audit)',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return {
        source,
        ecosystem: eco,
        package: pkgName,
        url: null,
        rawUrl: null,
        reason: `registry_http_${res.status}`,
      };
    }
    const data = await res.json();
    let rawUrl = null;
    if (source === 'registry.npmjs.org') {
      const repoField = typeof data?.repository === 'string' ? data.repository : data?.repository?.url;
      rawUrl = cleanGitUrl(repoField) ? repoField : (cleanGitUrl(data?.homepage) ? data.homepage : null);
    } else if (source === 'pypi.org') {
      rawUrl = extractGithubFromPyPIInfo(data?.info);
    } else if (source === 'crates.io') {
      const c = data?.crate;
      rawUrl = cleanGitUrl(c?.repository) ? c.repository : (cleanGitUrl(c?.homepage) ? c.homepage : null);
    }

    const slug = cleanGitUrl(rawUrl);
    if (!slug) {
      return {
        source,
        ecosystem: eco,
        package: pkgName,
        url: null,
        rawUrl: rawUrl || null,
        reason: 'no_github_repository_url_in_registry',
      };
    }

    return {
      source,
      ecosystem: eco,
      package: pkgName,
      url: `https://github.com/${slug}`,
      slug,
      rawUrl,
      reason: 'ok',
    };
  } catch (err) {
    return {
      source,
      ecosystem: eco,
      package: pkgName,
      url: null,
      rawUrl: null,
      reason: `registry_fetch_error:${err?.name || 'Error'}`,
    };
  }
}

/**
 * Compare l'ancre amont indépendante (`expected`) au dépôt résolu (`resolved`).
 */
export function identityVerdict(expected, resolved) {
  if (!expected || !expected.url) {
    return {
      status: 'UNANCHORED',
      match: null,
      note: expected?.reason || 'no_independent_upstream_anchor',
    };
  }

  const expectedSlug = cleanGitUrl(expected.url);
  if (!expectedSlug) {
    return {
      status: 'UNANCHORED',
      match: null,
      note: 'unparseable_expected_url',
    };
  }

  const resolvedSlug = cleanGitUrl(resolved?.slug || resolved?.full_name || resolved?.url || '');
  if (!resolvedSlug) {
    return {
      status: 'UNANCHORED',
      match: null,
      note: 'missing_resolved_slug',
    };
  }

  if (expectedSlug === resolvedSlug) {
    return {
      status: 'CANONICAL_MATCH',
      match: true,
      expectedSlug,
      resolvedSlug,
      source: expected.source || null,
    };
  }

  const aliasCandidates = [
    resolved?.inputSlug,
    resolved?.canonical_input,
    ...(Array.isArray(resolved?.aliases) ? resolved.aliases : []),
  ]
    .map(v => cleanGitUrl(v))
    .filter(Boolean);

  if (aliasCandidates.includes(expectedSlug)) {
    return {
      status: 'REDIRECTED',
      match: true,
      expectedSlug,
      resolvedSlug,
      source: expected.source || null,
    };
  }

  return {
    status: 'NAMESAKE_OR_FORK',
    match: false,
    expectedSlug,
    resolvedSlug,
    source: expected.source || null,
    note: 'upstream_registry_points_elsewhere',
  };
}

/**
 * Publie explicitement la portée et les limites de l'ancrage déclaratif sur registre.
 */
export function buildIdentityScope(verdict, expected) {
  const status = verdict?.status || 'UNANCHORED';
  const anchored = status === 'CANONICAL_MATCH' || status === 'REDIRECTED';
  return {
    status,
    attests: anchored
      ? 'le dépôt résolu correspond à ce que l\'éditeur du paquet déclare au registre'
      : null,
    does_not_attest: [
      'que ce soit le projet amont attendu',
      'la titularité du nom de paquet (chain_of_title)',
      'l\'absence de squat sur le registre déclaratif',
    ],
    anchor_declarative: Boolean(expected?.source),
    anchor_source: expected?.source || null,
  };
}
