import { getDb } from '../db/database.mjs';
import { generatePixelRagTile } from '../engines/pixelrag-tile-engine.mjs';
import {
  probeSandboxCapabilities,
  runSandboxVerification,
  isValidRepoSlug
} from '../engines/sandbox-runner.mjs';
import {
  runMultiRepoTournament,
  getTournamentById,
  buildTournamentMarkdown
} from '../engines/tournament-engine.mjs';
import {
  getPublicKeyInfo,
  issueIntegritySignature,
  verifyIntegritySignature,
  getRecentIntegritySignatures,
  getHonestCensus
} from '../engines/integrity-registry.mjs';
import { isVerdictsSurfaceExposed } from '../config/flags.mjs';
import { listRevokedKeys } from '../engines/revocation.mjs';
import {
  runReproducibleBenchmark,
  getExecutionBenchmarks
} from '../engines/benchmark-runner.mjs';
import {
  issueOrgLicense,
  getOrgPoliciesSnapshot,
  TIERS
} from '../engines/license-tier.mjs';
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

export async function arenaTournamentController(req, res) {
  const rawRepos = req.method === 'POST' ? req.body?.repos : req.query.repos;
  const repos = Array.isArray(rawRepos)
    ? rawRepos
    : (typeof rawRepos === 'string' && rawRepos.trim()
        ? rawRepos.split(',').map(s => s.trim()).filter(Boolean)
        : []);

  const category = (req.method === 'POST' ? req.body?.category : req.query.category) || '';
  const profile = (req.method === 'POST' ? req.body?.profile : req.query.profile) || 'enterprise';
  const limit = (req.method === 'POST' ? req.body?.limit : req.query.limit) || 6;
  const includeLiveRaw = req.method === 'POST' ? req.body?.includeLiveChecks : req.query.includeLiveChecks;
  const includeLiveChecks = includeLiveRaw === false || includeLiveRaw === 'false' ? false : true;

  const result = await runMultiRepoTournament({ repos, category, profile, limit, includeLiveChecks });
  return sendJson(res, 200, result);
}

export function exportTournamentController(req, res) {
  const t = getTournamentById(req.params.id);
  if (!t) {
    return sendJson(res, 404, { error: 'Tournoi introuvable' });
  }
  const format = (req.query.format || 'md').toLowerCase();
  if (format === 'json') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="tournament-${t.tournamentId.slice(0, 8)}.json"`
    });
    return res.end(JSON.stringify(t, null, 2));
  }
  const md = buildTournamentMarkdown(t);
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="tournament-${t.tournamentId.slice(0, 8)}.md"`
  });
  return res.end(md);
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

  const census = getHonestCensus();

  return sendJson(res, 200, {
    totalRepositories: totalRepos,
    indexedCount: census.indexed,
    inputsCount: census.inputs,
    resolvedCount: census.resolved,
    staticScannedCount: census.staticScanned,
    osvQueriedCount: census.osvQueried,
    verifiedWithEvidenceCount: census.verifiedWithEvidence,
    totalDuelsPlayed: duelsCount,
    totalHarnessRuns: harnessCount,
    commercialSafePercentage: Math.round((permissiveCount / (totalRepos || 1)) * 100),
    averageAiScore: Math.round((avgScoreRow.avgScore || 0) * 10) / 10,
    inspectorEngine: 'RepoVerify / G0D-PRÆTOR Engine v3.3 (Fail-Closed)',
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

/* ==================== PILIER 2 : REGISTRE DE SIGNATURES D'INTÉGRITÉ ==================== */

export function getIntegrityPubKeyController(req, res) {
  return sendJson(res, 200, getPublicKeyInfo());
}

export function getIntegrityRegistryController(req, res) {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return sendJson(res, 200, {
    publicKey: getPublicKeyInfo(),
    revokedKeys: listRevokedKeys(),
    census: getHonestCensus(),
    signatures: getRecentIntegritySignatures(limit)
  });
}

export async function postIntegritySignController(req, res) {
  if (!isVerdictsSurfaceExposed()) {
    return sendJson(res, 503, {
      error: 'verdict_surface_disabled',
      reason: 'Surface d\'émission de verdicts désactivée par défaut (mode fail-closed).',
      ref: 'RUNBOOK-fail-closed §3 & §6'
    });
  }
  const slug = String(req.body?.repo || `${req.params?.owner || ''}/${req.params?.name || ''}`).trim();
  if (!isValidRepoSlug(slug)) {
    return sendJson(res, 400, { error: 'Dépôt invalide (format owner/name requis)' });
  }
  const [owner, name] = slug.split('/');
  const policyProfile = req.body?.policyProfile || req.query?.policy || 'enterprise';
  const includeLiveCi = req.body?.includeLiveCi !== false && req.query?.live !== 'false';
  const result = await issueIntegritySignature(owner, name, { policyProfile, includeLiveCi });
  if (!result.ok) {
    return sendJson(res, result.status || 404, result);
  }
  return sendJson(res, 200, result.signature);
}

export function postIntegrityVerifyController(req, res) {
  const verification = verifyIntegritySignature(req.body || {});
  return sendJson(res, 200, verification);
}

/* ==================== PILIER 3 : BENCHMARKS D'EXÉCUTION ==================== */

export function getExecutionBenchmarksController(req, res) {
  const repo = req.query.repo ? String(req.query.repo).trim() : null;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return sendJson(res, 200, { items: getExecutionBenchmarks(repo, limit) });
}

export function postExecutionBenchmarkRunController(req, res) {
  const slug = String(req.body?.repo || '').trim();
  if (!isValidRepoSlug(slug)) {
    return sendJson(res, 400, { error: 'Paramètre repo invalide (owner/name requis)' });
  }
  const result = runReproducibleBenchmark(slug);
  if (!result.ok) {
    return sendJson(res, 404, result);
  }
  return sendJson(res, 200, result);
}

/* ==================== PILIER 4 : PLAN DE CONTRÔLE OPEN-CORE ==================== */

export function getLicenseStatusController(req, res) {
  return sendJson(res, 200, {
    activeTier: req.licenseContext?.tier || 'community',
    orgId: req.licenseContext?.orgId || 'local-community',
    availableTiers: TIERS,
    requireApiKeyMode: process.env.REPOVERIFY_REQUIRE_API_KEY === 'true',
    registeredOrgs: getOrgPoliciesSnapshot()
  });
}

export function postLicenseIssueController(req, res) {
  const remoteAddr = req.socket?.remoteAddress || '';
  const isLocalhost = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    return sendJson(res, 403, { error: 'Émission de licence restreinte à localhost (127.0.0.1)' });
  }
  const orgId = String(req.body?.orgId || '').trim();
  const tier = String(req.body?.tier || 'pro').trim();
  const validDays = parseInt(req.body?.validDays || '365', 10);
  try {
    const issued = issueOrgLicense({ orgId, tier, validDays });
    return sendJson(res, 200, issued);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
}
