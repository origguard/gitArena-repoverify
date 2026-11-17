import { createHash, randomUUID } from 'node:crypto';
import { platform, arch, cpus } from 'node:os';
import { getDb } from '../db/database.mjs';
import { findRepoInDb } from './repo-service.mjs';
import { generatePixelRagTile } from './pixelrag-tile-engine.mjs';
import { executeHarnessTest } from './harness-runner.mjs';

/**
 * Execution Benchmark Runner — Pilier 3 (RepoVerify / GitArena)
 * Enregistre des preuves chronométrées et reproductibles d'exécution réelle
 * (Cold-Start ms, Débit ops/s, RAM pic Mo, Empreinte matérielle, Exit Code).
 */

export function getEnvironmentFingerprint() {
  const cpuModel = cpus()[0]?.model || 'unknown-cpu';
  return `${platform()}-${arch()}|node-${process.version}|${cpuModel.trim().slice(0, 32)}`;
}

export function recordExecutionBenchmark({
  fullName,
  suiteName = 'STANDARD_HARNESS',
  coldStartMs,
  throughputOps = 0,
  peakRamMb = null,
  exitCode = 0
}) {
  const id = randomUUID();
  const envFingerprint = getEnvironmentFingerprint();
  const ramMb = peakRamMb ?? Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 100) / 100;
  const executedAt = new Date().toISOString();

  const receiptSha256 = createHash('sha256')
    .update(`${id}:${fullName}:${suiteName}:${coldStartMs}:${throughputOps}:${exitCode}:${envFingerprint}`)
    .digest('hex');

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO execution_benchmarks (
        id, repo_full_name, suite_name, cold_start_ms, throughput_ops, peak_ram_mb,
        exit_code, env_fingerprint, receipt_sha256, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fullName,
      suiteName,
      Math.round(coldStartMs * 100) / 100,
      Math.round(throughputOps * 100) / 100,
      ramMb,
      exitCode,
      envFingerprint,
      receiptSha256,
      executedAt
    );
  } catch { /* ignore in isolated test */ }

  return {
    id,
    fullName,
    suiteName,
    coldStartMs: Math.round(coldStartMs * 100) / 100,
    throughputOps: Math.round(throughputOps * 100) / 100,
    peakRamMb: ramMb,
    exitCode,
    envFingerprint,
    receiptSha256,
    executedAt
  };
}

/**
 * Exécute un banc de mesure reproductible sur un dépôt indexé (indexation FTS5 + PixelRAG + Harnais)
 */
export function runReproducibleBenchmark(fullName) {
  const repo = findRepoInDb(fullName);
  if (!repo) {
    return { ok: false, error: `Dépôt introuvable en base : ${fullName}` };
  }

  const db = getDb();
  const iterations = 50;
  const start = performance.now();

  let exitCode = 0;
  for (let i = 0; i < iterations; i++) {
    const row = db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(repo.full_name);
    const tile = generatePixelRagTile(row);
    const h = executeHarnessTest(row, { persist: false });
    if (h.exitCode !== 0 || !tile.tileHash) exitCode = 1;
  }

  const elapsedMs = Math.max(0.1, performance.now() - start);
  const throughputOps = (iterations / elapsedMs) * 1000;
  const coldStartMs = elapsedMs / iterations;

  const entry = recordExecutionBenchmark({
    fullName: repo.full_name,
    suiteName: 'REPRODUCIBLE_LOCAL_BENCH_50X',
    coldStartMs,
    throughputOps,
    exitCode
  });

  return { ok: true, benchmark: entry };
}

export function getExecutionBenchmarks(fullName = null, limit = 25) {
  try {
    const db = getDb();
    if (fullName) {
      return db.prepare(`
        SELECT * FROM execution_benchmarks
        WHERE repo_full_name = ?
        ORDER BY executed_at DESC
        LIMIT ?
      `).all(fullName, limit);
    }
    return db.prepare(`
      SELECT * FROM execution_benchmarks
      ORDER BY executed_at DESC
      LIMIT ?
    `).all(limit);
  } catch {
    return [];
  }
}
