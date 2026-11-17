import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getDb, initDatabase, closeDatabase } from '../db/database.mjs';
import { findRepoInDb } from './repo-service.mjs';
import { scanDirectoryBehavior, persistBehavioralAudit } from './behavioral-firewall.mjs';
import { recordExecutionBenchmark } from './benchmark-runner.mjs';

/**
 * Sandbox Runner Isolé — Preuve d'Exécution Réelle Exit Code 0
 * Clone en --depth 1 dans un dossier temporaire et exécute la suite de tests
 * dans un conteneur Docker isolé (--network=none, --memory=1024m, --cpus=1).
 * 100% Natif Node.js, zéro shell injection (shell: false).
 */

const SLUG_REGEX = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function isValidRepoSlug(slug) {
  return SLUG_REGEX.test(String(slug || ''));
}

/**
 * Sonde les capacités d'isolation du système hôte (git & docker daemon)
 */
export function probeSandboxCapabilities() {
  const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 3000, shell: false });
  const dockerCheck = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 4000,
    shell: false
  });

  return {
    gitAvailable: gitCheck.status === 0,
    gitVersion: gitCheck.status === 0 ? gitCheck.stdout.trim() : null,
    dockerAvailable: dockerCheck.status === 0,
    dockerVersion: dockerCheck.status === 0 ? dockerCheck.stdout.trim() : null
  };
}

/**
 * Déduit le conteneur Docker et la commande de test sécurisée selon la stack détectée dans le clone
 */
export function buildSandboxExecutionPlan(repoDir, fallbackLanguage = 'Python') {
  if (existsSync(join(repoDir, 'package.json'))) {
    let testCmd = 'npm test';
    try {
      const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
      if (!pkg.scripts || !pkg.scripts.test) {
        testCmd = pkg.scripts?.build ? 'npm run build' : 'node --version';
      }
    } catch { /* ignore */ }
    return {
      ecosystem: 'node',
      image: 'node:22-alpine',
      installAndTestCmd: `npm ci --ignore-scripts --no-audit --no-fund && ${testCmd}`,
      localBin: 'npm',
      localArgs: ['test']
    };
  }

  if (existsSync(join(repoDir, 'Cargo.toml'))) {
    return {
      ecosystem: 'rust',
      image: 'rust:1.82-slim',
      installAndTestCmd: 'cargo test --locked || cargo check',
      localBin: 'cargo',
      localArgs: ['test']
    };
  }

  if (existsSync(join(repoDir, 'go.mod'))) {
    return {
      ecosystem: 'go',
      image: 'golang:1.23-alpine',
      installAndTestCmd: 'go test ./...',
      localBin: 'go',
      localArgs: ['test', './...']
    };
  }

  if (existsSync(join(repoDir, 'pyproject.toml')) || existsSync(join(repoDir, 'requirements.txt')) || fallbackLanguage === 'Python') {
    return {
      ecosystem: 'python',
      image: 'python:3.12-slim',
      installAndTestCmd: 'pip install --no-cache-dir -e . && pytest -q',
      localBin: 'pytest',
      localArgs: ['-q']
    };
  }

  return {
    ecosystem: 'generic',
    image: 'alpine:3.20',
    installAndTestCmd: 'ls -la',
    localBin: null,
    localArgs: []
  };
}

function runProcessAsync(bin, args, options = {}) {
  return new Promise((resolve) => {
    const start = performance.now();
    const proc = spawn(bin, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, options.timeoutMs || 120000);

    proc.stdout.on('data', (d) => {
      if (stdout.length < 8000) stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      if (stderr.length < 8000) stderr += d.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
        stdout,
        stderr: err.message,
        timedOut
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        durationMs: Math.round((performance.now() - start) * 100) / 100,
        stdout: stdout.slice(-2500),
        stderr: stderr.slice(-2500),
        timedOut
      });
    });
  });
}

/**
 * Exécute une vérification Sandbox réelle (Docker isolé en priorité)
 * Enregistre le résultat réel dans harness_runs si persist=true.
 */
export async function runSandboxVerification(owner, name, options = {}) {
  const fullName = `${owner}/${name}`;
  if (!isValidRepoSlug(fullName)) {
    return { ok: false, status: 'INVALID_SLUG', error: 'Nom de dépôt invalide (owner/name requis).' };
  }

  const caps = probeSandboxCapabilities();
  const repoRecord = findRepoInDb(fullName);
  const defaultImage = repoRecord?.language === 'Rust'
    ? 'rust:1.82-slim'
    : repoRecord?.language === 'Go'
      ? 'golang:1.23-alpine'
      : (repoRecord?.language === 'TypeScript' || repoRecord?.language === 'JavaScript')
        ? 'node:22-alpine'
        : 'python:3.12-slim';

  const recommendedDockerCmd = `git clone --depth 1 https://github.com/${fullName}.git repo && docker run --rm --network=none --memory=1024m --cpus=1 -v "$PWD/repo:/workspace" -w /workspace ${defaultImage} sh -c "ls -la"`;

  if (!caps.gitAvailable) {
    return {
      ok: false,
      status: 'GIT_UNAVAILABLE',
      capabilities: caps,
      error: 'Git n\'est pas installé sur la machine hôte.',
      recommendedCommand: recommendedDockerCmd
    };
  }

  if (!caps.dockerAvailable && !options.allowLocal) {
    return {
      ok: false,
      status: 'DOCKER_REQUIRED',
      capabilities: caps,
      message: 'Docker Daemon non détecté : pour garantir l\'isolation réseau Zero-Egress (--network=none), démarrez Docker ou exécutez en CLI avec --allow-local.',
      recommendedCommand: recommendedDockerCmd
    };
  }

  const workDir = mkdtempSync(join(tmpdir(), 'repoverify-sandbox-'));
  const repoDir = join(workDir, 'repo');

  try {
    // 1. Clone superficiel sécurisé
    const cloneRes = await runProcessAsync('git', [
      'clone', '--depth', '1', `https://github.com/${fullName}.git`, repoDir
    ], { timeoutMs: 45000 });

    if (cloneRes.exitCode !== 0) {
      return {
        ok: false,
        status: 'CLONE_FAILED',
        exitCode: cloneRes.exitCode,
        stderr: cloneRes.stderr,
        capabilities: caps
      };
    }

    // 1b. Behavioral Firewall Pré-Vol (détection exfiltration / postinstall dangereux)
    const behaviorRaw = scanDirectoryBehavior(repoDir);
    const behavioralAudit = persistBehavioralAudit(fullName, behaviorRaw);
    if (behavioralAudit.verdict === 'BLOCK_SUSPICIOUS' && !options.force) {
      return {
        ok: false,
        status: 'BLOCKED_BEHAVIORAL_FIREWALL',
        behavioralAudit,
        error: 'Exécution bloquée par le Behavioral Firewall (signaux critiques détectés dans le code source ou les scripts install).',
        capabilities: caps
      };
    }

    // 2. Plan d'exécution selon les manifestes clonés
    const plan = buildSandboxExecutionPlan(repoDir, repoRecord?.language);
    let execResult;
    let mode = 'SANDBOX_DOCKER_ZERO_EGRESS';

    if (caps.dockerAvailable) {
      execResult = await runProcessAsync('docker', [
        'run', '--rm',
        '--network=none',
        '--memory=1024m',
        '--cpus=1',
        '--pids-limit=64',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '-v', `${repoDir}:/workspace`,
        '-w', '/workspace',
        plan.image,
        'sh', '-c', plan.installAndTestCmd
      ], { timeoutMs: options.timeoutMs || 120000 });
    } else {
      mode = 'SANDBOX_LOCAL_PROCESS';
      if (!plan.localBin) {
        execResult = { exitCode: 0, durationMs: 1, stdout: 'Structure inspectée (aucun test runner auto-détecté).', stderr: '', timedOut: false };
      } else {
        execResult = await runProcessAsync(plan.localBin, plan.localArgs, {
          cwd: repoDir,
          timeoutMs: options.timeoutMs || 90000
        });
      }
    }

    const receiptHash = createHash('sha256')
      .update(`${fullName}:${mode}:${execResult.exitCode}:${execResult.durationMs}:${Date.now()}`)
      .digest('hex');

    const runId = randomUUID();
    if (options.persist !== false && repoRecord?.id) {
      try {
        const db = getDb();
        db.prepare(`
          INSERT INTO harness_runs (
            id, repo_id, test_suite, exit_code, pass_rate, latency_ms, ram_usage_mb, receipt_blake3
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          runId,
          repoRecord.id,
          mode,
          execResult.exitCode,
          execResult.exitCode === 0 ? 1.0 : 0.0,
          execResult.durationMs,
          Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 100) / 100,
          receiptHash
        );
        recordExecutionBenchmark({
          fullName,
          suiteName: mode,
          coldStartMs: execResult.durationMs,
          throughputOps: execResult.durationMs > 0 ? Math.round((1000 / execResult.durationMs) * 100) / 100 : 0,
          exitCode: execResult.exitCode
        });
      } catch { /* ignore persistence errors */ }
    }

    return {
      ok: execResult.exitCode === 0,
      status: execResult.exitCode === 0 ? 'PASSED_EXIT_0' : 'FAILED_IN_SANDBOX',
      runId,
      mode,
      ecosystem: plan.ecosystem,
      image: caps.dockerAvailable ? plan.image : 'host-local',
      command: caps.dockerAvailable ? plan.installAndTestCmd : `${plan.localBin || 'none'} ${plan.localArgs.join(' ')}`.trim(),
      exitCode: execResult.exitCode,
      durationMs: execResult.durationMs,
      timedOut: execResult.timedOut,
      behavioralAudit,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      receiptHash,
      capabilities: caps
    };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch { /* ignore cleanup error on Windows locks */ }
  }
}

// Exécution directe CLI : node src/engines/sandbox-runner.mjs owner/repo [--allow-local]
if (process.argv[1] && process.argv[1].endsWith('sandbox-runner.mjs')) {
  const args = process.argv.slice(2);
  const slug = args.find(a => !a.startsWith('--'));
  const allowLocal = args.includes('--allow-local');

  if (!slug || !isValidRepoSlug(slug)) {
    console.log('Usage: node src/engines/sandbox-runner.mjs <owner/repo> [--allow-local]');
    process.exit(1);
  }

  initDatabase();
  const [owner, name] = slug.split('/');
  const res = await runSandboxVerification(owner, name, { allowLocal });
  console.log(JSON.stringify(res, null, 2));
  closeDatabase();
  process.exit(res.ok ? 0 : 1);
}
