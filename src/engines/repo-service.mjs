import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/database.mjs';
import { generatePixelRagTile } from './pixelrag-tile-engine.mjs';
import { executeHarnessTest } from './harness-runner.mjs';
import { calculateAiScore } from './ai-scoring-engine.mjs';
import { calculateEloUpdate } from './elo-engine.mjs';
import { deepInspect } from './gitingest-engine.mjs';
import { fetchCiTelemetry, buildGithubHeaders } from './ci-telemetry.mjs';
import { scanDependenciesVulnerabilities } from './osv-scanner.mjs';
import { generateRadarTelemetry } from './gods-eye-radar.mjs';
import { SovereignAutomationEngine } from '../workflows/workflow-engine.mjs';

export const PERMISSIVE_LICENSES = [
  'mit', 'apache-2.0', 'bsd-3-clause', 'bsd-2-clause', 'isc', '0bsd', 'unlicense'
];

const automationEngine = new SovereignAutomationEngine();
let workflowsReady = false;
function getAutomationEngine() {
  if (!workflowsReady) {
    automationEngine.initDefaultWorkflows();
    workflowsReady = true;
  }
  return automationEngine;
}

export function findRepoInDb(fullName) {
  const db = getDb();
  let repo = db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(fullName);
  if (!repo) {
    repo = db.prepare('SELECT * FROM repositories WHERE LOWER(full_name) = LOWER(?) LIMIT 1').get(fullName);
  }
  return repo || null;
}

/**
 * Ingestion Just-In-Time (JIT) depuis GitHub API avec gestion Rate-Limit et sizeKb réel
 */
export async function fetchAndIndexLiveRepo(owner, name) {
  const db = getDb();
  const fullName = `${owner}/${name}`;

  try {
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const response = await fetch(apiUrl, {
      headers: buildGithubHeaders(),
      signal: AbortSignal.timeout(8000)
    });

    if (response.status === 403 || response.status === 429) {
      const resetEpoch = response.headers.get('x-ratelimit-reset');
      return {
        rateLimited: true,
        retryAfter: resetEpoch ? new Date(Number(resetEpoch) * 1000).toISOString() : null
      };
    }

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const stars = data.stargazers_count || 0;
    const forks = data.forks_count || 0;
    const lang = data.language || 'Code';
    const license = data.license ? (data.license.spdx_id || data.license.name) : 'Non spécifiée';
    const description = data.description || `Dépôt open-source ${fullName} indexé à la demande.`;
    const pushedAt = data.pushed_at || new Date().toISOString();
    const sshUrl = data.ssh_url || `git@github.com:${fullName}.git`;
    const sizeKb = typeof data.size === 'number' ? data.size : 15000;

    let category = 'Général';
    const textCorpus = `${fullName} ${description}`.toLowerCase();
    if (textCorpus.includes('agent') || textCorpus.includes('crew') || textCorpus.includes('autogen') || textCorpus.includes('graph')) {
      category = "Frameworks d'Orchestration & Multi-Agents";
    } else if (textCorpus.includes('rag') || textCorpus.includes('vector') || textCorpus.includes('embed') || textCorpus.includes('search')) {
      category = 'Mémoire Étendue & RAG Avancé';
    } else if (textCorpus.includes('llm') || textCorpus.includes('inference') || textCorpus.includes('model') || textCorpus.includes('vllm') || textCorpus.includes('gguf')) {
      category = 'Outils de LLM, Serving & Inférence Local';
    } else if (textCorpus.includes('crawler') || textCorpus.includes('scrap') || textCorpus.includes('browser') || textCorpus.includes('playwright')) {
      category = 'Navigation Web & Automatisation IHM';
    } else if (textCorpus.includes('code') || textCorpus.includes('swe') || textCorpus.includes('compiler') || textCorpus.includes('transpiler')) {
      category = 'Agents de Codage & Génie Logiciel (SWE)';
    }

    const aiScore = calculateAiScore({
      stars,
      forks,
      pushedAt,
      hasDescription: Boolean(description),
      license,
      sizeKb
    });

    const eloRating = Math.round(1400 + (aiScore * 3.5));

    db.prepare(`
      INSERT INTO repositories (
        full_name, owner, name, ssh_url, stars, forks, language, license,
        ai_potential_score, elo_rating, pushed_at, description, category
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(full_name) DO UPDATE SET
        stars = excluded.stars,
        forks = excluded.forks,
        language = excluded.language,
        license = excluded.license,
        ai_potential_score = excluded.ai_potential_score,
        pushed_at = excluded.pushed_at,
        description = excluded.description,
        category = excluded.category,
        updated_at = datetime('now')
    `).run(
      fullName, owner, name, sshUrl, stars, forks, lang, license,
      aiScore, eloRating, pushedAt, description, category
    );

    console.log(`[JIT-INDEXER] ✓ Nouveau dépôt indexé : ${fullName} (Stars: ${stars}, Score IA: ${aiScore}, Size: ${sizeKb}KB)`);

    const newRecord = db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(fullName);
    if (newRecord) newRecord.autoIndexed = true;
    return newRecord;
  } catch (err) {
    console.error(`[JIT-INDEXER ERROR] Échec pour ${fullName}:`, err.message);
    return null;
  }
}

export function generateQuickstart(repo, cachedIntel = null) {
  const scripts = cachedIntel?.detectedScripts || {};

  if (repo.language === 'Python') {
    const testCmd = scripts.test || 'pytest';
    return [
      `git clone ${repo.ssh_url}`,
      `cd ${repo.name} && python -m venv .venv && source .venv/bin/activate`,
      `pip install -e . && ${testCmd}`
    ];
  }
  if (repo.language === 'TypeScript' || repo.language === 'JavaScript') {
    const runCmd = scripts.test ? 'npm test' : (scripts.build ? 'npm run build' : (scripts.start ? 'npm start' : 'npm test'));
    return [
      `git clone ${repo.ssh_url}`,
      `cd ${repo.name}`,
      `npm install && ${runCmd}`
    ];
  }
  if (repo.language === 'Rust') {
    return [
      `git clone ${repo.ssh_url}`,
      `cd ${repo.name}`,
      `cargo build --release && cargo test`
    ];
  }
  if (repo.language === 'Go') {
    return [
      `git clone ${repo.ssh_url}`,
      `cd ${repo.name}`,
      `go mod download && go test ./...`
    ];
  }
  return [
    `git clone ${repo.ssh_url}`,
    `cd ${repo.name}`,
    `cat README.md`
  ];
}

function getCachedIntelSync(fullName) {
  try {
    const db = getDb();
    const cached = db.prepare('SELECT * FROM gitingest_cache WHERE full_name = ?').get(fullName);
    if (!cached) return null;
    const projectHealth = JSON.parse(cached.project_health_json || '{}');
    return {
      available: true,
      projectHealth,
      detectedScripts: projectHealth._detectedScripts || {},
      runtimeConstraint: projectHealth._runtimeConstraint || null
    };
  } catch {
    return null;
  }
}

export async function inspectRepository(owner, name, options = {}) {
  const db = getDb();
  const fullName = `${owner}/${name}`;
  const includeLiveCi = options.includeLiveCi !== false;

  let repo = findRepoInDb(fullName);

  if (!repo) {
    const liveResult = await fetchAndIndexLiveRepo(owner, name);
    if (liveResult && liveResult.rateLimited) {
      return {
        ok: false,
        status: 429,
        payload: {
          error: 'Quota de l\'API GitHub temporairement atteint (Rate-Limit).',
          retryAfter: liveResult.retryAfter,
          suggestion: 'Définissez GITHUB_TOKEN dans l\'environnement ou réessayez après réinitialisation du quota.'
        }
      };
    }
    repo = liveResult;
  }

  if (!repo) {
    return {
      ok: false,
      status: 404,
      payload: {
        error: 'Dépôt introuvable sur GitHub ou inaccessible publiquement',
        query: fullName,
        suggestion: 'Vérifiez l\'orthographe du compte propriétaire et du dépôt (ex: facebook/react, torvalds/linux).'
      }
    };
  }

  // Télémétrie CI/CD réelle (GitHub Actions) + cache GitIngest local si déjà présent
  const ciTelemetry = includeLiveCi
    ? await fetchCiTelemetry(repo.owner, repo.name)
    : { available: false, source: 'Mode hors-ligne / rapide', recentRuns: [] };

  const cachedIntel = getCachedIntelSync(repo.full_name);

  // Diagnostic mécanique d'intégrité (persistant dans harness_runs)
  const harnessResult = executeHarnessTest(repo, {
    ciTelemetry,
    codeIntel: cachedIntel,
    persist: options.persistHarness !== false
  });

  const now = new Date();
  const pushDate = new Date(repo.pushed_at || now.toISOString());
  const daysSincePush = Math.max(0, Math.round((now.getTime() - pushDate.getTime()) / (1000 * 60 * 60 * 24)));

  let healthStatus = 'OPTIMAL';
  let healthSummary = 'Projet activement maintenu, audit mécanique conforme.';
  if (daysSincePush > 180) {
    healthStatus = 'WARNING_INACTIVE';
    healthSummary = `Attention : Aucun commit depuis ${daysSincePush} jours. Risque de dépendances obsolètes.`;
  } else if (ciTelemetry.available && ciTelemetry.lastRunStatus === 'FAILURE') {
    healthStatus = 'WARNING_CI_FAILING';
    healthSummary = 'Attention : Le dernier workflow GitHub Actions a échoué.';
  }

  const defaultRuntime = repo.language === 'Python'
    ? 'Python >= 3.10'
    : (repo.language === 'TypeScript' || repo.language === 'JavaScript')
      ? 'Node.js >= 20.x'
      : repo.language === 'Rust'
        ? 'Rust >= 1.78 (Cargo)'
        : repo.language === 'Go'
          ? 'Go >= 1.22'
          : 'Standard Toolchain';

  const passRateDisplay = ciTelemetry.available && typeof ciTelemetry.ciPassRate === 'number'
    ? `${ciTelemetry.ciPassRate}% (CI GitHub Actions)`
    : `${Math.round(harnessResult.passRate * 1000) / 10}% (Audit ${harnessResult.verificationMode === 'CODE_INTEL_AUDIT' ? 'Code Intel' : 'Structurel'})`;

  const envRequirements = {
    runtime: cachedIntel?.runtimeConstraint || defaultRuntime,
    ramMinMb: repo.stars > 50000 ? 4096 : 2048,
    exitCode: harnessResult.exitCode,
    passRate: passRateDisplay,
    verificationMode: harnessResult.verificationMode
  };

  const quickstartCommands = generateQuickstart(repo, cachedIntel);

  const licenseLower = String(repo.license || '').toLowerCase();
  const isPermissive = PERMISSIVE_LICENSES.includes(licenseLower);
  const legalAudit = {
    licenseSpdx: repo.license || 'Non spécifiée',
    commercialSafe: isPermissive,
    copyleftRisk: !isPermissive,
    bigCodeCompliant: isPermissive,
    recommendation: isPermissive
      ? 'Licence permissive vérifiée : intégration commerciale et entraînement de modèles IA sans risque de contamination virale.'
      : 'Attention : Licence avec clauses restrictives ou copyleft (GPL/AGPL/NC/Inconnue). Validation juridique requise avant intégration commerciale.'
  };

  const pixelTile = generatePixelRagTile(repo);

  let alternatives = db.prepare(`
    SELECT full_name, name, stars, elo_rating, ai_potential_score, language, license
    FROM repositories
    WHERE category = ? AND id != ?
    ORDER BY ai_potential_score DESC, stars DESC
    LIMIT 3
  `).all(repo.category, repo.id);

  if (alternatives.length === 0) {
    alternatives = db.prepare(`
      SELECT full_name, name, stars, elo_rating, ai_potential_score, language, license
      FROM repositories
      WHERE id != ?
      ORDER BY ai_potential_score DESC, stars DESC
      LIMIT 3
    `).all(repo.id);
  }

  const reportHash = createHash('sha256')
    .update(`${repo.full_name}:${healthStatus}:${legalAudit.commercialSafe}:${harnessResult.receiptHash}`)
    .digest('hex');

  return {
    ok: true,
    status: 200,
    payload: {
      repository: repo,
      health: {
        status: healthStatus,
        summary: healthSummary,
        daysSinceLastPush: daysSincePush,
        harnessRun: harnessResult,
        ciTelemetry,
        environment: envRequirements,
        quickstart: quickstartCommands
      },
      legalAndSecurity: legalAudit,
      pixelRagArchitecture: {
        tileHash: pixelTile.tileHash,
        tileSvgUrl: `/api/pixelrag/tile/${repo.owner}/${repo.name}`
      },
      modernAlternatives: alternatives,
      auditReceipt: {
        reportHash,
        inspectedAt: now.toISOString(),
        verifiedExitCode: harnessResult.exitCode,
        autoIndexedLive: Boolean(repo.autoIndexed)
      }
    }
  };
}

export async function inspectCodeIntelligence(owner, name) {
  const report = await deepInspect(owner, name);
  if (!report || !report.available) {
    return report;
  }

  const vulnerabilities = await scanDependenciesVulnerabilities(report.dependencies);
  return {
    ...report,
    vulnerabilities
  };
}

export function searchRepositories(query = {}) {
  const db = getDb();
  const startTime = performance.now();

  const q = query.q ? String(query.q).trim() : '';
  const lang = query.lang ? String(query.lang).trim() : '';
  const category = query.category ? String(query.category).trim() : '';
  const license = query.license ? String(query.license).trim().toLowerCase() : '';
  const minScore = parseFloat(query.minScore);
  const sort = query.sort || 'ai_score';
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const offset = Math.max(0, parseInt(query.offset, 10) || 0);

  let sortColumn = 'repositories.ai_potential_score DESC';
  if (sort === 'stars') sortColumn = 'repositories.stars DESC';
  if (sort === 'name') sortColumn = 'repositories.name ASC';
  if (sort === 'elo') sortColumn = 'repositories.elo_rating DESC';

  const whereClauses = [];
  const params = [];

  if (lang) {
    whereClauses.push('repositories.language = ?');
    params.push(lang);
  }
  if (category) {
    whereClauses.push('repositories.category = ?');
    params.push(category);
  }
  if (license === 'permissive') {
    const placeholders = PERMISSIVE_LICENSES.map(() => '?').join(',');
    whereClauses.push(`LOWER(repositories.license) IN (${placeholders})`);
    params.push(...PERMISSIVE_LICENSES);
  } else if (license) {
    whereClauses.push('LOWER(repositories.license) = ?');
    params.push(license);
  }
  if (!Number.isNaN(minScore) && minScore > 0) {
    whereClauses.push('repositories.ai_potential_score >= ?');
    params.push(minScore);
  }

  let items = [];
  let total = 0;

  if (q) {
    const cleanQ = q.replace(/[^a-zA-Z0-9_\-./]/g, ' ').trim();
    if (cleanQ) {
      const tokens = cleanQ.split(/[\s/]+/).filter(Boolean);
      const ftsQuery = tokens.map(t => `"${t}"*`).join(' OR ');
      const extraWhere = whereClauses.length > 0 ? `AND ${whereClauses.join(' AND ')}` : '';
      try {
        const countRow = db.prepare(`
          SELECT COUNT(*) as cnt
          FROM repositories_fts
          JOIN repositories ON repositories.id = repositories_fts.rowid
          WHERE repositories_fts MATCH ? ${extraWhere}
        `).get(ftsQuery, ...params);
        total = countRow ? countRow.cnt : 0;

        items = db.prepare(`
          SELECT repositories.*
          FROM repositories_fts
          JOIN repositories ON repositories.id = repositories_fts.rowid
          WHERE repositories_fts MATCH ? ${extraWhere}
          ORDER BY ${sortColumn}
          LIMIT ? OFFSET ?
        `).all(ftsQuery, ...params, limit, offset);
      } catch {
        const likeWhere = `(repositories.full_name LIKE ? OR repositories.description LIKE ?) ${extraWhere}`;
        const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM repositories WHERE ${likeWhere}`).get(`%${cleanQ}%`, `%${cleanQ}%`, ...params);
        total = countRow ? countRow.cnt : 0;
        items = db.prepare(`
          SELECT * FROM repositories
          WHERE ${likeWhere}
          ORDER BY ${sortColumn}
          LIMIT ? OFFSET ?
        `).all(`%${cleanQ}%`, `%${cleanQ}%`, ...params, limit, offset);
      }
    }
  } else {
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM repositories ${whereSql}`).get(...params);
    total = countRow ? countRow.cnt : 0;

    items = db.prepare(`
      SELECT * FROM repositories
      ${whereSql}
      ORDER BY ${sortColumn}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
  }

  const queryTimeMs = Math.round((performance.now() - startTime) * 100) / 100;
  return { total, limit, offset, queryTimeMs, items };
}

export function getFiltersMeta() {
  const db = getDb();
  const languages = db.prepare('SELECT language, COUNT(*) as count FROM repositories GROUP BY language ORDER BY count DESC').all();
  const categories = db.prepare('SELECT category, COUNT(*) as count FROM repositories GROUP BY category ORDER BY count DESC').all();
  return { languages, categories };
}

export function getArenaDuel(options = {}) {
  const db = getDb();
  let repoA = null;
  let repoB = null;

  if (options.repoA && options.repoB) {
    repoA = findRepoInDb(options.repoA);
    repoB = findRepoInDb(options.repoB);
  }

  if (!repoA || !repoB || repoA.id === repoB.id) {
    if (options.category) {
      const pool = db.prepare('SELECT * FROM repositories WHERE category = ? ORDER BY RANDOM() LIMIT 2').all(options.category);
      if (pool.length === 2) {
        [repoA, repoB] = pool;
      }
    }
    if (!repoA || !repoB) {
      // Sélectionner 2 dépôts dans la même catégorie en priorité, sinon aléatoire
      const anchor = db.prepare('SELECT * FROM repositories ORDER BY RANDOM() LIMIT 1').get();
      if (anchor) {
        const peer = db.prepare('SELECT * FROM repositories WHERE category = ? AND id != ? ORDER BY RANDOM() LIMIT 1').get(anchor.category, anchor.id)
          || db.prepare('SELECT * FROM repositories WHERE id != ? ORDER BY RANDOM() LIMIT 1').get(anchor.id);
        repoA = anchor;
        repoB = peer;
      }
    }
  }

  if (!repoA || !repoB) {
    return null;
  }

  const enrich = (r) => {
    const intel = getCachedIntelSync(r.full_name);
    const licLower = String(r.license || '').toLowerCase();
    return {
      ...r,
      commercialSafe: PERMISSIVE_LICENSES.includes(licLower),
      daysSinceLastPush: Math.max(0, Math.round((Date.now() - new Date(r.pushed_at).getTime()) / 86400000)),
      hasCachedIntel: Boolean(intel)
    };
  };

  return {
    duelId: randomUUID(),
    category: repoA.category === repoB.category ? repoA.category : 'Cross-Category Clash',
    repoA: enrich(repoA),
    repoB: enrich(repoB)
  };
}

export async function submitArenaVote({ repoAId, repoBId, winner, voterFingerprint = 'anonymous' }) {
  const db = getDb();
  const repoA = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repoAId);
  const repoB = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repoBId);

  if (!repoA || !repoB || repoA.id === repoB.id) {
    return { ok: false, error: 'Dépôts invalides pour le duel' };
  }

  // winner: 'A' | 'B' | 'DRAW'
  let outcome = 0.5;
  let winnerId = null;
  if (winner === 'A') {
    outcome = 1.0;
    winnerId = repoA.id;
  } else if (winner === 'B') {
    outcome = 0.0;
    winnerId = repoB.id;
  }

  const eloUpdate = calculateEloUpdate(repoA.elo_rating, repoB.elo_rating, outcome, 32);
  const duelId = randomUUID();

  db.exec('BEGIN TRANSACTION;');
  try {
    db.prepare('UPDATE repositories SET elo_rating = ?, updated_at = datetime(\'now\') WHERE id = ?').run(eloUpdate.newRatingA, repoA.id);
    db.prepare('UPDATE repositories SET elo_rating = ?, updated_at = datetime(\'now\') WHERE id = ?').run(eloUpdate.newRatingB, repoB.id);
    db.prepare(`
      INSERT INTO arena_duels (
        id, repo_a_id, repo_b_id, winner_id,
        repo_a_elo_before, repo_b_elo_before, repo_a_elo_after, repo_b_elo_after,
        voter_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      duelId,
      repoA.id,
      repoB.id,
      winnerId,
      repoA.elo_rating,
      repoB.elo_rating,
      eloUpdate.newRatingA,
      eloUpdate.newRatingB,
      voterFingerprint
    );
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  // Déclencher le workflow de synchronisation du leaderboard
  const wfSync = await getAutomationEngine().runWorkflow('wf-leaderboard-sync', { duelId, winner });

  return {
    ok: true,
    duelId,
    winner,
    repoA: { id: repoA.id, full_name: repoA.full_name, eloBefore: repoA.elo_rating, eloAfter: eloUpdate.newRatingA, delta: eloUpdate.deltaA },
    repoB: { id: repoB.id, full_name: repoB.full_name, eloBefore: repoB.elo_rating, eloAfter: eloUpdate.newRatingB, delta: eloUpdate.deltaB },
    workflowSync: wfSync
  };
}

export function getRecentDuels(limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT d.id, d.winner_id, d.repo_a_elo_before, d.repo_a_elo_after,
           d.repo_b_elo_before, d.repo_b_elo_after, d.created_at,
           ra.full_name as repo_a_name, rb.full_name as repo_b_name
    FROM arena_duels d
    JOIN repositories ra ON ra.id = d.repo_a_id
    JOIN repositories rb ON rb.id = d.repo_b_id
    ORDER BY d.created_at DESC
    LIMIT ?
  `).all(limit);
}

export function getRadarData(options = {}) {
  const db = getDb();
  const limit = Math.min(200, Math.max(10, parseInt(options.limit, 10) || 80));
  const category = options.category ? String(options.category).trim() : '';

  const rows = category
    ? db.prepare('SELECT * FROM repositories WHERE category = ? ORDER BY elo_rating DESC, ai_potential_score DESC LIMIT ?').all(category, limit)
    : db.prepare('SELECT * FROM repositories ORDER BY elo_rating DESC, ai_potential_score DESC LIMIT ?').all(limit);

  return generateRadarTelemetry(rows);
}

export function getWorkflowsSnapshot() {
  const eng = getAutomationEngine();
  return {
    registered: [...eng.workflows.values()].map(w => ({ id: w.id, name: w.name, stepsCount: w.steps.length })),
    recentExecutions: eng.getAuditLog(15)
  };
}

export async function triggerWorkflowById(workflowId) {
  const eng = getAutomationEngine();
  return eng.runWorkflow(workflowId);
}

export function buildDueDiligenceMarkdown(inspectPayload, codeIntel = null) {
  const { repository: repo, health, legalAndSecurity: legal, auditReceipt } = inspectPayload;
  const lines = [
    `# Rapport de Due-Diligence Open-Source — ${repo.full_name}`,
    ``,
    `- **Généré par** : RepoVerify / G0D-PRÆTOR Sovereign Engine`,
    `- **Date d'audit** : ${auditReceipt.inspectedAt}`,
    `- **Empreinte SHA-256** : \`${auditReceipt.reportHash}\``,
    `- **URL GitHub** : https://github.com/${repo.full_name}`,
    `- **SSH** : \`${repo.ssh_url}\``,
    ``,
    `## 1. Score & Métriques`,
    `| Indicateur | Valeur |`,
    `| :--- | :--- |`,
    `| Score Potentiel IA | **${repo.ai_potential_score} / 100** |`,
    `| Rating ELO Arène | **${repo.elo_rating}** |`,
    `| Stars / Forks | ${repo.stars.toLocaleString()} ★ / ${repo.forks.toLocaleString()} forks |`,
    `| Langage / Catégorie | ${repo.language} • ${repo.category} |`,
    ``,
    `## 2. Santé d'Exécution & CI/CD`,
    `- **Statut global** : \`${health.status}\` (Exit Code : \`${health.environment.exitCode}\`)`,
    `- **Mode de vérification** : \`${health.environment.verificationMode}\``,
    `- **Taux de fiabilité** : ${health.environment.passRate}`,
    `- **Dernier commit** : il y a ${health.daysSinceLastPush} jours`,
    `- **Runtime requis** : ${health.environment.runtime}`,
    ``,
    `## 3. Audit Juridique & Conformité`,
    `- **Licence SPDX** : \`${legal.licenseSpdx}\``,
    `- **Usage Commercial** : ${legal.commercialSafe ? 'AUTORISÉ (Permissive)' : 'RISQUE COPYLEFT / RESTRICTIF'}`,
    `- **BigCode The Stack v2** : ${legal.bigCodeCompliant ? 'CONFORME' : 'NON RECOMMANDÉ'}`,
    `- **Avis** : ${legal.recommendation}`,
    ``,
    `## 4. Déploiement Rapide`,
    '```bash',
    ...health.quickstart,
    '```'
  ];

  if (codeIntel && codeIntel.available) {
    lines.push(
      ``,
      `## 5. Code Intelligence & Supply-Chain`,
      `- **Score Maturité** : ${codeIntel.maturityScore} / 100`,
      `- **Fichiers analysés** : ${codeIntel.filesAnalyzed} (~${codeIntel.estimatedTokens} tokens — ${codeIntel.aiContextFit?.recommendedTier || 'N/A'})`,
      `- **Gestionnaire** : ${codeIntel.dependencies?.manager || 'Inconnu'} (${codeIntel.dependencies?.count || 0} dépendances)`
    );
    if (codeIntel.vulnerabilities && codeIntel.vulnerabilities.scanned) {
      lines.push(`- **Scan CVE OSV.dev** : ${codeIntel.vulnerabilities.totalVulnerabilities} vulnérabilité(s) sur ${codeIntel.vulnerabilities.packagesChecked} paquets vérifiés (Gravité max : \`${codeIntel.vulnerabilities.maxSeverity}\`)`);
    }
  }

  return lines.join('\n');
}
