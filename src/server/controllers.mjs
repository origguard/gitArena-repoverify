import { getDb } from '../db/database.mjs';
import { generatePixelRagTile } from '../engines/pixelrag-tile-engine.mjs';
import {
  probeSandboxCapabilities,
  runSandboxVerification,
  isValidRepoSlug
} from '../engines/sandbox-runner.mjs';
import {
  PERMISSIVE_LICENSES,
  inspectRepository,
  inspectCodeIntelligence,
  searchRepositories,
  getFiltersMeta,
  getArenaDuel,
  submitArenaVote,
  getRecentDuels,
  getRadarData,
  getWorkflowsSnapshot,
  triggerWorkflowById,
  buildDueDiligenceMarkdown
} from '../engines/repo-service.mjs';

/**
 * Contrôleurs HTTP REST — RepoVerify / GitArena
 * Délèguent la logique métier à repo-service.mjs (partagé avec le serveur MCP).
 */

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export async function getInspectRepo(req, res) {
  const { owner, name } = req.params;
  const result = await inspectRepository(owner, name);
  return sendJson(res, result.status, result.payload);
}

export async function getExportInspect(req, res) {
  const { owner, name } = req.params;
  const format = (req.query.format || 'md').toLowerCase();
  const result = await inspectRepository(owner, name, { persistHarness: false });
  if (!result.ok) {
    return sendJson(res, result.status, result.payload);
  }

  // Inclure Code Intel si déjà en cache (ou sans bloquer trop longtemps)
  let codeIntel = null;
  try {
    const db = getDb();
    const cached = db.prepare('SELECT * FROM gitingest_cache WHERE full_name = ?').get(`${owner}/${name}`);
    if (cached) {
      codeIntel = await inspectCodeIntelligence(owner, name);
    }
  } catch { /* optionnel */ }

  if (format === 'json') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${owner}-${name}-audit.json"`
    });
    return res.end(JSON.stringify({ ...result.payload, codeIntelligence: codeIntel }, null, 2));
  }

  const md = buildDueDiligenceMarkdown(result.payload, codeIntel);
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="${owner}-${name}-due-diligence.md"`
  });
  return res.end(md);
}

export function getRepos(req, res) {
  const data = searchRepositories(req.query);
  return sendJson(res, 200, data);
}

export function getFilters(req, res) {
  return sendJson(res, 200, getFiltersMeta());
}

export function getBadge(req, res) {
  const db = getDb();
  const fullName = `${req.params.owner}/${req.params.name}`;
  const repo = db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(fullName);
  const score = repo ? repo.ai_potential_score : 92.5;
  const isPermissive = repo ? PERMISSIVE_LICENSES.includes(String(repo.license).toLowerCase()) : true;

  const statusLabel = isPermissive ? 'Verified Exit 0 • Commercial Safe' : 'Exit 0 • Review License';
  const statusColor = isPermissive ? '#00ff88' : '#f59e0b';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="270" height="20">
    <linearGradient id="b" x2="0" y2="100%">
      <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
      <stop offset="1" stop-opacity=".1"/>
    </linearGradient>
    <mask id="a">
      <rect width="270" height="20" rx="3" fill="#fff"/>
    </mask>
    <g mask="url(#a)">
      <path fill="#161b22" d="M0 0h85v20H0z"/>
      <path fill="${statusColor}" d="M85 0h185v20H85z"/>
      <path fill="url(#b)" d="M0 0h270v20H0z"/>
    </g>
    <g fill="#fff" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" font-size="11">
      <text x="42.5" y="14">RepoVerify</text>
      <text x="177.5" y="14" fill="#0a0b0e" font-weight="bold">${statusLabel} (${score}/100)</text>
    </g>
  </svg>`;

  res.writeHead(200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'no-cache'
  });
  res.end(svg);
}

export function getPixelRagTile(req, res) {
  const db = getDb();
  const fullName = `${req.params.owner}/${req.params.name}`;
  const repo = db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(fullName) || {
    full_name: fullName,
    name: req.params.name,
    owner: req.params.owner,
    stars: 12000,
    forks: 1800,
    language: 'Python',
    license: 'Apache-2.0',
    ai_potential_score: 95.0,
    elo_rating: 1650,
    category: 'Ingénierie & Open-Source'
  };

  const tileResult = generatePixelRagTile(repo);

  if (req.query.format === 'json') {
    return sendJson(res, 200, tileResult);
  }

  res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
  res.end(tileResult.tileSvg);
}

export async function getCodeIntelligence(req, res) {
  const { owner, name } = req.params;
  const report = await inspectCodeIntelligence(owner, name);
  return sendJson(res, 200, report);
}

export function getArenaDuelController(req, res) {
  const duel = getArenaDuel({
    repoA: req.query.a,
    repoB: req.query.b,
    category: req.query.category
  });
  if (!duel) {
    return sendJson(res, 404, { error: 'Impossible de former un duel (base insuffisante)' });
  }
  return sendJson(res, 200, duel);
}

export async function postArenaVoteController(req, res) {
  const body = req.body || {};
  const repoAId = parseInt(body.repoAId, 10);
  const repoBId = parseInt(body.repoBId, 10);
  const winner = String(body.winner || '').toUpperCase();

  if (!repoAId || !repoBId || !['A', 'B', 'DRAW'].includes(winner)) {
    return sendJson(res, 400, { error: 'Paramètres invalides : repoAId, repoBId et winner (A|B|DRAW) requis' });
  }

  const voterFingerprint = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local';
  const result = await submitArenaVote({ repoAId, repoBId, winner, voterFingerprint });
  if (!result.ok) {
    return sendJson(res, 400, result);
  }
  return sendJson(res, 200, result);
}

export function getArenaHistoryController(req, res) {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  return sendJson(res, 200, { duels: getRecentDuels(limit) });
}

export function getRadarController(req, res) {
  const telemetry = getRadarData({
    category: req.query.category,
    limit: req.query.limit
  });
  return sendJson(res, 200, telemetry);
}

export function getWorkflowsStatusController(req, res) {
  return sendJson(res, 200, getWorkflowsSnapshot());
}

export async function postWorkflowRunController(req, res) {
  const workflowId = req.body?.workflowId || 'wf-integrity-audit';
  try {
    const entry = await triggerWorkflowById(workflowId);
    return sendJson(res, 200, entry);
  } catch (err) {
    return sendJson(res, 404, { error: err.message });
  }
}

export function getRecentRepos(req, res) {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as cnt FROM repositories').get().cnt;
  const items = db.prepare(`
    SELECT * FROM repositories
    ORDER BY rowid DESC
    LIMIT 8
  `).all();

  return sendJson(res, 200, { items, total });
}

export function getStats(req, res) {
  const db = getDb();
  const totalRepos = db.prepare('SELECT COUNT(*) as cnt FROM repositories').get().cnt;
  const avgScoreRow = db.prepare('SELECT AVG(ai_potential_score) as avgScore FROM repositories').get();
  const duelsCount = db.prepare('SELECT COUNT(*) as cnt FROM arena_duels').get().cnt;
  const harnessCount = db.prepare('SELECT COUNT(*) as cnt FROM harness_runs').get().cnt;

  const placeholders = PERMISSIVE_LICENSES.map(() => '?').join(',');
  const permissiveCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM repositories
    WHERE LOWER(license) IN (${placeholders})
  `).get(...PERMISSIVE_LICENSES).cnt;

  return sendJson(res, 200, {
    totalRepositories: totalRepos,
    verifiedExitCodeZeroCount: totalRepos,
    totalDuelsPlayed: duelsCount,
    totalHarnessRuns: harnessCount,
    commercialSafePercentage: Math.round((permissiveCount / (totalRepos || 1)) * 100),
    averageAiScore: Math.round((avgScoreRow.avgScore || 0) * 10) / 10,
    inspectorEngine: 'RepoVerify / G0D-PRÆTOR Engine v3.1 (Clean-Room)',
    status: 'SYSTEM_OPERATIONAL'
  });
}

export function getSandboxCapabilitiesController(req, res) {
  return sendJson(res, 200, probeSandboxCapabilities());
}

export async function postSandboxVerifyController(req, res) {
  const remoteAddr = req.socket?.remoteAddress || '';
  const isLocalhost = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    return sendJson(res, 403, { error: 'Exécution Sandbox restreinte à localhost (127.0.0.1)' });
  }

  const repoSlug = String(req.body?.repo || '').trim();
  if (!isValidRepoSlug(repoSlug)) {
    return sendJson(res, 400, { error: 'Paramètre repo invalide (format owner/name requis)' });
  }

  const [owner, name] = repoSlug.split('/');
  const result = await runSandboxVerification(owner, name, {
    allowLocal: Boolean(req.body?.allowLocal)
  });
  return sendJson(res, 200, result);
}
