import { createHash } from 'node:crypto';

/**
 * Modèle de Preuve & Décision Fail-Closed — Runbook §4
 * Absence de preuve ≠ preuve d'absence.
 * Fonction pure : aucune I/O, aucun accès base, aucune valeur par défaut positive.
 */

export const Evidence = Object.freeze({
  NONE: 0,
  METADATA_ONLY: 1,
  STATIC_SCANNED: 2,
  OSV_QUERIED: 3,
  EXECUTED: 4
});

export const EvidenceName = Object.freeze(
  Object.fromEntries(Object.entries(Evidence).map(([k, v]) => [v, k]))
);

export const Verdict = Object.freeze({
  INDETERMINATE: 'INDETERMINATE',
  ALLOW: 'ALLOW',
  WARN: 'WARN',
  DENY: 'DENY'
});

export const ALLOW_FLOOR = Evidence.OSV_QUERIED;

export const SCOPE_NOTICE =
  "Ce résultat porte sur l'analyse statique de manifestes/motifs sensibles et l'interrogation OSV disponibles au moment de l'émission. " +
  "Il ne porte pas sur l'exécution isolée (sauf evidenceLevel === 4 avec Docker actif), le comportement runtime complet, l'exhaustivité des vulnérabilités ni la licéité d'usage. " +
  "Un dépôt INDETERMINATE n'a pas été suffisamment analysé et n'est pas déclaré sûr.";

export const ASSURANCE_LIMITATIONS = Object.freeze({
  chain_of_title: 'not_attested',
  lawfulness_of_acquisition: 'not_attested',
  patents: 'out_of_scope',
  legal_basis_of_use: 'not_attested'
});

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
    .join(',')}}`;
}

export function computeCanonicalFingerprint(input) {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

export function levelOf(behavioral, osv, execution) {
  if (execution?.ran === true && (execution.isolationScore ?? 0) >= 70 && execution.instrumented === true) {
    return Evidence.EXECUTED;
  }
  if (osv?.scanned === true) {
    if (behavioral?.scanMode === 'STATIC') return Evidence.OSV_QUERIED;
    return Evidence.OSV_QUERIED;
  }
  if (behavioral?.scanMode === 'STATIC') return Evidence.STATIC_SCANNED;
  if (behavioral?.scanMode === 'METADATA_ONLY') return Evidence.METADATA_ONLY;
  return Evidence.NONE;
}

function missingStages(level, floor = ALLOW_FLOOR, behavioral = null, osv = null) {
  const need = [];
  if (behavioral?.scanMode !== 'STATIC' && level < Evidence.EXECUTED) {
    need.push('static_scan');
  }
  if (!osv?.scanned && floor >= Evidence.OSV_QUERIED) {
    need.push('osv_query');
  }
  if (floor >= Evidence.EXECUTED && level < Evidence.EXECUTED) {
    need.push('isolated_execution');
  }
  return [...new Set(need)];
}

function refsOf(...sources) {
  return sources
    .filter(Boolean)
    .map(s => s.ref)
    .filter(r => typeof r === 'string' && r.trim().length > 0);
}

/**
 * Fonction pure fail-closed :
 * 1) Preuve positive de malveillance => DENY, quelle que soit la couverture.
 * 2) Couverture < floor => INDETERMINATE (jamais positif).
 * 3) Couverture >= floor, findings non critiques => WARN.
 * 4) Couverture >= floor, aucun finding => ALLOW.
 */
/**
 * I9 · Inventaire borné des 12 entrées de porte & audit pessimiste.
 * Chaque champ alimentant une décision doit avoir une provenance et un défaut pessimiste.
 */
export const GATE_INPUTS = Object.freeze([
  { field: 'deps_resolved', from: 'lockfile parse', defaultVal: null, optimistic: false },
  { field: 'deps_queried', from: 'batch send count', defaultVal: 0, optimistic: true },
  { field: 'deps_answered', from: 'osv answered count', defaultVal: 0, optimistic: false },
  { field: 'findings', from: 'static scan', defaultVal: null, optimistic: true },
  { field: 'vulns', from: 'osv results', defaultVal: null, optimistic: true },
  { field: 'lockfile_used', from: 'probe read', defaultVal: null, optimistic: false },
  { field: 'identity_status', from: 'registry anchor', defaultVal: 'UNANCHORED', optimistic: false },
  { field: 'scan_mode', from: 'probe outcome', defaultVal: null, optimistic: false },
  { field: 'archived', from: 'github api', defaultVal: null, optimistic: true },
  { field: 'license_spdx', from: 'github api', defaultVal: null, optimistic: false },
  { field: 'coverage_gate', from: 'gateCompleteness()', defaultVal: 'INDETERMINATE', optimistic: false },
  { field: 'truncated', from: 'git trees', defaultVal: null, optimistic: true },
]);

export function auditGateInputs(inputs = {}) {
  const missingOrOptimistic = [];
  if (!Number.isFinite(inputs.deps_resolved) || inputs.deps_resolved <= 0) missingOrOptimistic.push('deps_resolved');
  if (!Number.isFinite(inputs.deps_queried) || inputs.deps_queried <= 0) missingOrOptimistic.push('deps_queried');
  if (!Number.isFinite(inputs.deps_answered) || inputs.deps_answered <= 0) missingOrOptimistic.push('deps_answered');
  if (!Array.isArray(inputs.findings)) missingOrOptimistic.push('findings');
  if (!Array.isArray(inputs.vulns)) missingOrOptimistic.push('vulns');
  if (!inputs.lockfile_used || typeof inputs.lockfile_used !== 'string') missingOrOptimistic.push('lockfile_used');
  if (!inputs.identity_status || inputs.identity_status === 'UNANCHORED') missingOrOptimistic.push('identity_status');
  if (!inputs.scan_mode) missingOrOptimistic.push('scan_mode');
  if (typeof inputs.archived !== 'boolean') missingOrOptimistic.push('archived');
  if (!inputs.license_spdx) missingOrOptimistic.push('license_spdx');
  if (inputs.coverage_gate !== 'PASS') missingOrOptimistic.push('coverage_gate');
  if (typeof inputs.truncated !== 'boolean') missingOrOptimistic.push('truncated');

  const blocksAllow =
    missingOrOptimistic.length > 0 ||
    inputs.archived === true ||
    inputs.truncated === true;

  return {
    pass: !blocksAllow,
    cap: blocksAllow ? 'INDETERMINATE' : 'ALLOW',
    missingOrOptimistic,
    registry: GATE_INPUTS,
  };
}

export function decide({ behavioral = null, osv = null, execution = null } = {}, floor = ALLOW_FLOOR) {
  const level = levelOf(behavioral, osv, execution);
  const evidenceName = EvidenceName[level];
  const evidenceRefs = refsOf(behavioral, osv, execution);
  const findingsExplicitMissing = behavioral?.scanMode === 'STATIC' && !Array.isArray(behavioral?.findings);
  const vulnsExplicitMissing = osv?.scanned === true && (osv.vulns === null || osv.depsAnswered === 0);
  const findings = Array.isArray(behavioral?.findings) ? behavioral.findings : [];
  const critical = findings.filter(f => f?.severity === 'CRITICAL' || f?.severity === 'critical');
  const osvCritical = osv?.scanned === true && (osv.maxSeverity === 'CRITICAL' || osv.maxSeverity === 'HIGH');
  const base = { evidenceLevel: level, evidenceName, evidenceRefs };

  if (critical.length > 0 || osvCritical) {
    const reasons = critical.map(f => f.ruleId || f.id || 'unnamed_critical');
    if (osvCritical) reasons.push(`OSV_${osv.maxSeverity}`);
    return {
      ...base,
      verdict: Verdict.DENY,
      reasons,
      missing: []
    };
  }

  if (level < floor || findingsExplicitMissing || vulnsExplicitMissing) {
    const miss = missingStages(level, floor, behavioral, osv);
    if (findingsExplicitMissing) miss.push('behavioral_findings');
    if (vulnsExplicitMissing) miss.push('osv_answered');
    return {
      ...base,
      verdict: Verdict.INDETERMINATE,
      reasons: ['insufficient_evidence'],
      missing: [...new Set(miss)]
    };
  }

  if (findings.length > 0) {
    return {
      ...base,
      verdict: Verdict.WARN,
      reasons: findings.map(f => f.ruleId || f.id || 'unnamed_finding'),
      missing: []
    };
  }

  return {
    ...base,
    verdict: Verdict.ALLOW,
    reasons: [],
    missing: []
  };
}

/**
 * Un verdict positif sans référence de preuve vérifiable est une opinion, pas un résultat.
 */
export function isSignable(result) {
  if (!result || !result.verdict) return false;
  if (result.verdict === Verdict.INDETERMINATE) return true;
  return Array.isArray(result.evidenceRefs) && result.evidenceRefs.length > 0;
}

export function evaluatePolicyAction(result, profile = 'community') {
  if (!result || result.verdict === Verdict.DENY) {
    return { action: 'block' };
  }
  if (result.verdict === Verdict.WARN) {
    return { action: profile === 'enterprise' || profile === 'strict' ? 'block' : 'warn' };
  }
  if (result.verdict === Verdict.INDETERMINATE) {
    return {
      action: profile === 'enterprise' || profile === 'strict' ? 'block' : 'warn',
      notice: "dépôt non analysé — absence de preuve, pas preuve d'absence"
    };
  }
  return { action: 'allow' };
}
