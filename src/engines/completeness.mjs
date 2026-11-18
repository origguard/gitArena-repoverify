/**
 * I6 · Complétude de couverture des dépendances & visibilité des avis OSV.
 *
 * Empêche qu'un scan sur manifestes directs seuls ou qu'une requête OSV partielle
 * soit promu en verdict ALLOW. Calcule également le filtre de visibilité stricte
 * des avis par rapport au périmètre effectivement interrogé.
 */

export const CAP = Object.freeze({
  DENY: 0,
  INDETERMINATE: 1,
  WARN: 2,
  ALLOW: 3,
});

export const CAP_NAME = Object.freeze(['DENY', 'INDETERMINATE', 'WARN', 'ALLOW']);

export const DEFAULT_CFG = Object.freeze({
  enabled: true,
  threshold: 0.98,
  requireTransitive: true,
});

/**
 * Calcule les métriques de couverture des dépendances pour un dépôt / écosystème.
 */
export function assessCoverage({
  lockfile = null,
  deps_declared = null,
  deps_resolved = null,
  deps_queried = 0,
  transitive = false,
} = {}) {
  const declared = Number.isFinite(deps_declared) ? Number(deps_declared) : null;
  const resolved = Number.isFinite(deps_resolved) ? Number(deps_resolved) : null;
  const queried = Number.isFinite(deps_queried) ? Number(deps_queried) : 0;

  let ratio = null;
  if (resolved !== null && resolved > 0) {
    ratio = Math.min(1, Number((queried / resolved).toFixed(4)));
  }

  return {
    lockfile: lockfile || null,
    deps_declared: declared,
    deps_resolved: resolved,
    deps_queried: queried,
    ratio,
    transitive: Boolean(transitive),
  };
}

/**
 * Évalue la porte I6 de complétude et retourne le plafond de verdict (`cap`).
 */
export function gateCompleteness(cov, cfg = DEFAULT_CFG) {
  const effectiveCfg = { ...DEFAULT_CFG, ...(cfg || {}) };

  if (!effectiveCfg.enabled) {
    return { gate: 'DISABLED', cap: 'ALLOW' };
  }
  if (!cov || !cov.lockfile) {
    return { gate: 'NO_LOCKFILE', cap: 'INDETERMINATE' };
  }
  if (cov.deps_resolved == null || !Number.isFinite(cov.deps_resolved) || cov.deps_resolved <= 0) {
    return { gate: 'RESOLVED_UNKNOWN', cap: 'INDETERMINATE' };
  }

  const ratio = Number.isFinite(cov.ratio)
    ? cov.ratio
    : cov.deps_queried / cov.deps_resolved;

  if (!Number.isFinite(ratio) || ratio < effectiveCfg.threshold) {
    return { gate: 'INCOMPLETE_QUERY', cap: 'INDETERMINATE' };
  }
  if (effectiveCfg.requireTransitive && !cov.transitive) {
    return { gate: 'DIRECT_ONLY', cap: 'WARN' };
  }

  return { gate: 'PASS', cap: 'ALLOW' };
}

/**
 * Plafonne un verdict de base selon `cap` (monotonie stricte vers le bas).
 */
export function applyCap(baseVerdict, cap) {
  const baseIdx = CAP[baseVerdict] ?? CAP.INDETERMINATE;
  const capIdx = CAP[cap] ?? CAP.INDETERMINATE;
  return CAP_NAME[Math.min(baseIdx, capIdx)];
}

/**
 * Ne conserve que les avis OSV dont le paquet figure dans les noms interrogés.
 */
export function visibleAdvisories(allAdvisories, queriedNames) {
  if (!Array.isArray(allAdvisories) || !queriedNames) return [];
  const allowed = new Set(
    Array.from(queriedNames, name => String(name ?? '').trim().toLowerCase()).filter(Boolean)
  );
  if (allowed.size === 0) return [];

  return allAdvisories.filter(adv => {
    const pkgName = String(
      adv?.package ??
      adv?.pkg ??
      adv?.affected?.[0]?.package?.name ??
      ''
    ).trim().toLowerCase();
    return pkgName !== '' && allowed.has(pkgName);
  });
}

/**
 * Évaluation complète d'un dépôt à partir des métriques de sonde manifestes + OSV.
 */
export function assessRepo({
  manifestProbe = null,
  lockfileUsed = null,
  depsDeclared = null,
  depsResolved = null,
  depsQueried = 0,
  cfg = DEFAULT_CFG,
} = {}) {
  const lockfile = lockfileUsed || null;
  const transitive = Boolean(lockfile) && Number.isFinite(depsResolved) && depsResolved > 0;
  const coverage = assessCoverage({
    lockfile,
    deps_declared: depsDeclared,
    deps_resolved: depsResolved,
    deps_queried: depsQueried,
    transitive,
  });
  const gate = gateCompleteness(coverage, cfg);
  const hasManifests = Boolean(manifestProbe?.found?.length) || depsQueried > 0 || (depsDeclared ?? 0) > 0;

  return {
    coverage,
    gate,
    scope: {
      scope: lockfile ? 'lockfile_transitive' : (hasManifests ? 'manifest_direct' : 'no_manifests'),
      lockfile,
    },
  };
}

/**
 * I7 · Décomposition exacte des raisons sur les dépôts ayant passé la couverture (`pass_coverage`).
 * Garantit zéro chute anonyme : findingsOnly + advisoriesOnly + both + verified === rows.length.
 */
export function decomposeReasons(rows = []) {
  let blockedFindingsOnly = 0;
  let blockedAdvisoriesOnly = 0;
  let blockedBoth = 0;
  let deniedCritical = 0;
  let verifiedAsResolved = 0;

  for (const r of rows) {
    const f = Number.isFinite(r?.findings) ? r.findings : Number(r?.f ?? 0);
    const v = Number.isFinite(r?.vulns) ? r.vulns : Number(r?.v ?? 0);
    const crit = Number.isFinite(r?.critical) ? r.critical : Number(r?.crit ?? 0);

    if (crit > 0) deniedCritical++;
    if (f > 0 && v === 0) blockedFindingsOnly++;
    else if (f === 0 && v > 0) blockedAdvisoriesOnly++;
    else if (f > 0 && v > 0) blockedBoth++;
    else verifiedAsResolved++;
  }

  const passCoverage = rows.length;
  const accounted = blockedFindingsOnly + blockedAdvisoriesOnly + blockedBoth + verifiedAsResolved;
  return {
    passCoverage,
    blockedFindingsOnly,
    blockedAdvisoriesOnly,
    blockedBoth,
    deniedCritical,
    verifiedAsResolved,
    accounted,
    exactSum: accounted === passCoverage,
  };
}

/**
 * I8 · Bande de sanity en sortie d'exécution : transforme un écart inattendu
 * en alerte d'invariant sur les gates plutôt qu'en auto-satisfaction.
 */
export function checkBand(observed, { lo = 5, hi = 40 } = {}) {
  const obs = Number(observed);
  const within = Number.isFinite(obs) && obs >= lo && obs <= hi;
  return {
    within,
    observed: obs,
    lo,
    hi,
    action: within ? 'publish' : 'HOLD_suspect_gate',
    note: within
      ? null
      : `sortie hors bande [${lo}, ${hi}] (observé=${obs}) : suspecter un coverage_gate PASS par défaut, un plafond non appliqué ou une jointure qui double les lignes`,
  };
}
