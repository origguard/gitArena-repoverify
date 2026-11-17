import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SovereignRouter } from './router.mjs';
import * as controllers from './controllers.mjs';
import { initDatabase } from '../db/database.mjs';
import { resolveRequestLicenseContext } from '../engines/license-tier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = join(__dirname, '../public');

export function createGitArenaServer() {
  const router = new SovereignRouter();

  // Catalogue, recherche FTS5 et filtres
  router.get('/api/repos', controllers.getRepos);
  router.get('/api/repos/recent', controllers.getRecentRepos);
  router.get('/api/filters', controllers.getFilters);

  // Inspection chirurgicale, export, Code Intel, PixelRAG et Badges
  router.get('/api/inspect/:owner/:name', controllers.getInspectRepo);
  router.get('/api/inspect/:owner/:name/export', controllers.getExportInspect);
  router.get('/api/codeintel/:owner/:name', controllers.getCodeIntelligence);
  router.get('/api/badge/:owner/:name', controllers.getBadge);
  router.get('/api/pixelrag/tile/:owner/:name', controllers.getPixelRagTile);

  // Arène dialectique, classement ELO & Tournois multi-dépôts (4 à 8 repos)
  router.get('/api/arena/duel', controllers.getArenaDuelController);
  router.post('/api/arena/vote', controllers.postArenaVoteController);
  router.get('/api/arena/history', controllers.getArenaHistoryController);
  router.get('/api/arena/tournament', controllers.arenaTournamentController);
  router.post('/api/arena/tournament', controllers.arenaTournamentController);
  router.get('/api/arena/tournament/:id/export', controllers.exportTournamentController);

  // Radar tactique God's Eye & Workflows autonomes
  router.get('/api/radar', controllers.getRadarController);
  router.get('/api/workflows/status', controllers.getWorkflowsStatusController);
  router.post('/api/workflows/run', controllers.postWorkflowRunController);

  // Sandbox Docker isolé & Behavioral Firewall (Pilier 1)
  router.get('/api/sandbox/capabilities', controllers.getSandboxCapabilitiesController);
  router.post('/api/sandbox/verify', controllers.postSandboxVerifyController);

  // Registre de Signatures d'Intégrité Ed25519 (Pilier 2 — émission fermée 503 par défaut)
  router.get('/api/integrity/pubkey', controllers.getIntegrityPubKeyController);
  router.get('/api/integrity/registry', controllers.getIntegrityRegistryController);
  router.get('/api/integrity/sign/:owner/:name', controllers.postIntegritySignController);
  router.post('/api/integrity/sign', controllers.postIntegritySignController);
  router.post('/api/integrity/verify', controllers.postIntegrityVerifyController);

  // Benchmarks d'Exécution Chronométrés (Pilier 3)
  router.get('/api/benchmarks/execution', controllers.getExecutionBenchmarksController);
  router.post('/api/benchmarks/execution/run', controllers.postExecutionBenchmarkRunController);

  // Plan de Contrôle Open-Core (Pilier 4)
  router.get('/api/license/status', controllers.getLicenseStatusController);
  router.post('/api/license/issue', controllers.postLicenseIssueController);

  // Statistiques globales
  router.get('/api/stats', controllers.getStats);

  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-RepoVerify-Key, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // Résolution du palier de licence Open-Core sur /api/*
    if (req.url && req.url.startsWith('/api/')) {
      const licCtx = resolveRequestLicenseContext(req);
      if (!licCtx.authorized) {
        res.writeHead(licCtx.status || 401, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: licCtx.error }));
      }
      req.licenseContext = licCtx;
    }

    try {
      await router.handle(req, res, publicDir);
    } catch (err) {
      console.error('[SERVER ERROR]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erreur interne du serveur', message: err.message }));
    }
  });

  return server;
}

export function startServer(port = 8080) {
  initDatabase();
  const server = createGitArenaServer();

  server.listen(port, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`🔍 RepoVerify / GitArena — G0D-PRÆTOR Sovereign Engine`);
    console.log(`🛡️  CI/CD Live, OSV Supply-Chain, PixelRAG, Arène ELO & Radar`);
    console.log(`📡 URL Locale : http://localhost:${port}/`);
    console.log(`======================================================\n`);
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const port = parseInt(process.env.PORT, 10) || 8080;
  startServer(port);
}
