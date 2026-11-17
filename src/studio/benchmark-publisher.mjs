import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, closeDatabase } from '../db/database.mjs';
import { runMultiRepoTournament, buildTournamentMarkdown } from '../engines/tournament-engine.mjs';
import { findHeadlessBrowser, buildCarouselHtml, renderHtmlToCarouselPdf } from './video-studio.mjs';

/**
 * Benchmark Library Publisher — RepoVerify / GitArena
 * Génère et actualise la bibliothèque publique des résultats de tournois
 * dans `benchmarks/` (Markdown, JSON structuré, PDF Carrousel + Index README).
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BENCHMARKS_DIR = join(__dirname, '../../benchmarks');

export const BENCHMARK_SUITES = [
  {
    slug: 'agents-ia-enterprise',
    title: "Frameworks d'Agents IA & Orchestration",
    category: "Frameworks d'Orchestration & Agents IA",
    profile: 'enterprise',
    hook: '6 FRAMEWORKS AGENTS IA : QUI PASSE LA PROD ?',
    repos: [
      'langchain-ai/langgraph',
      'crewAIInc/crewAI',
      'microsoft/autogen',
      'All-Hands-AI/OpenHands',
      'Aider-AI/aider',
      'Significant-Gravitas/AutoGPT'
    ]
  },
  {
    slug: 'scraping-web-automation',
    title: 'Scraping Web & Automatisation Browser IA',
    category: 'Navigation Web & Scraping IA',
    profile: 'enterprise',
    hook: '6 OUTILS SCRAPING IA : LICENCES & CI AUDITÉES',
    repos: [
      'browser-use/browser-use',
      'unclecode/crawl4ai',
      'vercel-labs/agent-browser',
      'apify/crawlee',
      'mendableai/firecrawl',
      'Skyvern-AI/skyvern'
    ]
  },
  {
    slug: 'llm-serving-inference',
    title: 'Moteurs de Serving & Inférence LLM Locale',
    category: 'LLM Serving & Inférence Locale',
    profile: 'balanced',
    hook: '5 MOTEURS LLM : LE CLASSEMENT TECHNIQUE',
    repos: [
      'ollama/ollama',
      'vllm-project/vllm',
      'ggml-org/llama.cpp',
      'hiyouga/LlamaFactory',
      'huggingface/transformers'
    ]
  },
  {
    slug: 'vector-databases-rag',
    title: 'Bases Vectorielles & Pipelines RAG',
    category: 'Mémoire Étendue, Vector DB & RAG',
    profile: 'ai_training',
    hook: '6 BASES VECTORIELLES & RAG : CONFORMITÉ BIGCODE',
    repos: [
      'qdrant/qdrant',
      'milvus-io/milvus',
      'chroma-core/chroma',
      'run-llama/llama_index',
      'infiniflow/ragflow',
      'mem0ai/mem0'
    ]
  }
];

function buildBenchmarksIndexReadme(entries, generatedAt) {
  const rows = entries.map(e => {
    const pdfLink = e.pdfFile ? ` • [📕 PDF (5 slides)](./${e.pdfFile})` : '';
    return `| **${e.title}** | ${e.profileLabel} | 🏆 **${e.champion}** (${e.championScore}/100) | ${e.candidatesCount} | [📄 Markdown](./${e.mdFile}) • [🧾 JSON](./${e.jsonFile})${pdfLink} |`;
  });

  return [
    `# 📊 Bibliothèque Publique de Benchmarks — RepoVerify / GitArena`,
    ``,
    `> **Dernière actualisation :** ${generatedAt} • **Moteur :** RepoVerify Sovereign Engine (SQLite FTS5 + GitHub Actions CI + OSV.dev + Bus Factor)`,
    ``,
    `Consultez et téléchargez gratuitement nos comparatifs multi-dépôts vérifiés (licences commerciales *BigCode The Stack v2*, santé CI/CD, Bus Factor des mainteneurs et vulnérabilités Supply-Chain).`,
    ``,
    `## Rapports Disponibles`,
    ``,
    `| Domaine | Profil d'Évaluation | Champion Recommandé | Candidats | Ressources Téléchargeables |`,
    `| :--- | :--- | :--- | :---: | :--- |`,
    ...rows,
    ``,
    `---`,
    ``,
    `## 🔍 Auditer votre propre shortlist ou vos dépôts privés`,
    `- **En local (Open-Source Apache-2.0) :** \`npm start\` puis ouvrez l'onglet **⚔️ Arène & Comparateur ➔ 🏆 Tournoi Survival**.`,
    `- **Prestation B2B / Due-Diligence confidentielle (48 h) :** Besoin d'auditer une codebase privée avant une mise en production, un rachat ou une levée de fonds ? Utilisez RepoVerify en interne ou contactez l'équipe **OrigGuard** pour un audit scellé sur mesure.`,
    ``
  ].join('\n');
}

export async function publishAllBenchmarks(options = {}) {
  mkdirSync(BENCHMARKS_DIR, { recursive: true });
  const browserPath = options.skipPdf ? null : findHeadlessBrowser();
  const entries = [];
  const generatedAt = new Date().toISOString();

  for (const suite of BENCHMARK_SUITES) {
    const t = await runMultiRepoTournament({
      repos: suite.repos,
      category: suite.category,
      profile: suite.profile,
      limit: suite.repos.length,
      includeLiveChecks: options.includeLiveChecks !== false
    });

    const mdFile = `${suite.slug}.md`;
    const jsonFile = `${suite.slug}.json`;
    let pdfFile = null;

    writeFileSync(join(BENCHMARKS_DIR, mdFile), buildTournamentMarkdown(t), 'utf8');
    writeFileSync(join(BENCHMARKS_DIR, jsonFile), JSON.stringify(t, null, 2), 'utf8');

    if (browserPath) {
      try {
        pdfFile = `${suite.slug}.pdf`;
        const carouselHtml = buildCarouselHtml(t, suite.hook);
        await renderHtmlToCarouselPdf(browserPath, carouselHtml, join(BENCHMARKS_DIR, pdfFile));
      } catch (err) {
        console.warn(`[BENCHMARK PDF WARN] ${suite.slug}:`, err.message);
        pdfFile = null;
      }
    }

    entries.push({
      slug: suite.slug,
      title: suite.title,
      profileLabel: t.profileMeta?.label || suite.profile,
      champion: t.champion?.fullName || 'N/A',
      championScore: t.champion?.profileScore ?? 0,
      candidatesCount: t.candidatesCount,
      mdFile,
      jsonFile,
      pdfFile
    });
  }

  writeFileSync(join(BENCHMARKS_DIR, 'README.md'), buildBenchmarksIndexReadme(entries, generatedAt), 'utf8');
  return { count: entries.length, generatedAt, entries };
}

if (process.argv[1] && process.argv[1].endsWith('benchmark-publisher.mjs')) {
  const args = process.argv.slice(2);
  const skipPdf = args.includes('--no-pdf');
  const offline = args.includes('--offline');

  initDatabase();
  try {
    const res = await publishAllBenchmarks({
      skipPdf,
      includeLiveChecks: !offline
    });
    console.log('[BENCHMARK-PUBLISHER] ✓ Bibliothèque générée :', JSON.stringify(res, null, 2));
  } finally {
    closeDatabase();
  }
}
