import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/database.mjs';

/**
 * Harness Runner Déterministe — Cour Prévôtale
 * Conforme aux règles d'or de Harness Engineering (Exit Code 0, Persistance harness_runs & Quittance SHA-256)
 */

export function executeHarnessTest(repo, options = {}) {
  const startTime = performance.now();
  const ciTelemetry = options.ciTelemetry || null;
  const codeIntel = options.codeIntel || null;
  const persist = options.persist !== false;

  // 1. Contrôles mécaniques d'intégrité structurelle
  const hasValidName = Boolean(repo.full_name && repo.full_name.includes('/'));
  const hasValidSsh = Boolean(repo.ssh_url && repo.ssh_url.startsWith('git@github.com:'));
  const hasValidScore = typeof repo.ai_potential_score === 'number' && repo.ai_potential_score >= 0;
  const hasLicense = Boolean(repo.license && repo.license !== 'Non spécifiée');

  // 2. Calcul du passRate réel : basé sur CI GitHub Actions si disponible, sinon sur l'audit structurel
  let passRate = 1.0;
  let verificationMode = 'STRUCTURAL_AUDIT';
  let passed = hasValidName && hasValidSsh && hasValidScore;

  if (ciTelemetry && ciTelemetry.available && typeof ciTelemetry.ciPassRate === 'number') {
    passRate = Math.round((ciTelemetry.ciPassRate / 100) * 1000) / 1000;
    verificationMode = 'GITHUB_ACTIONS_LIVE';
    passed = passed && (ciTelemetry.lastRunStatus !== 'FAILURE');
  } else if (codeIntel && codeIntel.available) {
    // Score basé sur les indicateurs réels du code source (CI + Tests + Lockfile + README)
    const ph = codeIntel.projectHealth || {};
    const checks = [hasValidName, hasValidSsh, hasLicense, Boolean(ph.hasReadme), Boolean(ph.hasTests), Boolean(ph.hasCI)];
    passRate = Math.round((checks.filter(Boolean).length / checks.length) * 1000) / 1000;
    verificationMode = 'CODE_INTEL_AUDIT';
  } else {
    const checks = [hasValidName, hasValidSsh, hasValidScore, hasLicense];
    passRate = Math.round((checks.filter(Boolean).length / checks.length) * 1000) / 1000;
  }

  const durationMs = Math.max(0.01, Math.round((performance.now() - startTime) * 100) / 100);
  const ramUsageMb = Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 100) / 100;
  const exitCode = passed ? 0 : 1;

  // 3. Condensat cryptographique de quittance
  const receiptPayload = `${repo.full_name}:${repo.ai_potential_score}:${exitCode}:${passRate}:${verificationMode}:${Date.now()}`;
  const receiptHash = createHash('sha256').update(receiptPayload).digest('hex');

  const result = {
    runId: randomUUID(),
    repoId: repo.id,
    fullName: repo.full_name,
    exitCode,
    passRate,
    verificationMode,
    latencyMs: durationMs,
    ramUsageMb,
    receiptHash,
    status: exitCode === 0 ? 'PASSED_CODE_0' : 'WARNING_CHECK_REQUIRED'
  };

  // 4. Persister dans harness_runs si repo.id valide
  if (persist && repo.id) {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO harness_runs (
          id, repo_id, test_suite, exit_code, pass_rate, latency_ms, ram_usage_mb, receipt_blake3
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.runId,
        repo.id,
        verificationMode,
        result.exitCode,
        result.passRate,
        result.latencyMs,
        result.ramUsageMb,
        result.receiptHash
      );
    } catch { /* ignore si table absente en test unitaire isolé */ }
  }

  return result;
}
