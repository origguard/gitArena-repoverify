import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getDb, initDatabase } from './database.mjs';
import { calculateAiScore } from '../engines/ai-scoring-engine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Métadonnées de référence pour les dépôts fondateurs (avec vrai owner/name)
const FOUNDER_HEURISTICS = {
  'huggingface/transformers': { lang: 'Python', lic: 'Apache-2.0', stars: 138000, forks: 26500, cat: 'Outils de LLM, Serving & Inférence Local' },
  'pytorch/pytorch': { lang: 'Python', lic: 'BSD-3-Clause', stars: 91000, forks: 23000, cat: 'Fondations & Systèmes' },
  'kubernetes/kubernetes': { lang: 'Go', lic: 'Apache-2.0', stars: 112000, forks: 40000, cat: 'Fondations & Systèmes' },
  'vercel/next.js': { lang: 'TypeScript', lic: 'MIT', stars: 128000, forks: 27000, cat: 'Fondations & Systèmes' },
  'microsoft/TypeScript': { lang: 'TypeScript', lic: 'Apache-2.0', stars: 102000, forks: 13000, cat: 'Fondations & Systèmes' },
  'rust-lang/rust': { lang: 'Rust', lic: 'MIT', stars: 99000, forks: 12500, cat: 'Fondations & Systèmes' },
  'golang/go': { lang: 'Go', lic: 'BSD-3-Clause', stars: 125000, forks: 17500, cat: 'Fondations & Systèmes' },
  'ollama/ollama': { lang: 'Go', lic: 'MIT', stars: 110000, forks: 10500, cat: 'Outils de LLM, Serving & Inférence Local' },
  'ggml-org/llama.cpp': { lang: 'C++', lic: 'MIT', stars: 74000, forks: 10200, cat: 'Outils de LLM, Serving & Inférence Local' },
  'langchain-ai/langchain': { lang: 'Python', lic: 'MIT', stars: 97000, forks: 15500, cat: "Frameworks d'Orchestration & Multi-Agents" },
  'langchain-ai/langgraph': { lang: 'Python', lic: 'MIT', stars: 18500, forks: 2400, cat: "Frameworks d'Orchestration & Multi-Agents" },
  'crewAIInc/crewAI': { lang: 'Python', lic: 'MIT', stars: 26000, forks: 3600, cat: "Frameworks d'Orchestration & Multi-Agents" },
  'microsoft/autogen': { lang: 'Python', lic: 'Apache-2.0', stars: 36000, forks: 5100, cat: "Frameworks d'Orchestration & Multi-Agents" },
  'Significant-Gravitas/AutoGPT': { lang: 'Python', lic: 'MIT', stars: 168000, forks: 44000, cat: "Frameworks d'Orchestration & Multi-Agents" },
  'All-Hands-AI/OpenHands': { lang: 'Python', lic: 'MIT', stars: 41000, forks: 5200, cat: 'Agents de Codage & Génie Logiciel (SWE)' },
  'Aider-AI/aider': { lang: 'Python', lic: 'Apache-2.0', stars: 24000, forks: 2300, cat: 'Agents de Codage & Génie Logiciel (SWE)' },
  'browser-use/browser-use': { lang: 'Python', lic: 'MIT', stars: 31000, forks: 3400, cat: 'Navigation Web & Automatisation IHM' },
  'unclecode/crawl4ai': { lang: 'Python', lic: 'Apache-2.0', stars: 22000, forks: 2100, cat: 'Navigation Web & Automatisation IHM' },
  'mendableai/firecrawl': { lang: 'TypeScript', lic: 'AGPL-3.0', stars: 23000, forks: 2100, cat: 'Navigation Web & Automatisation IHM' },
  'vllm-project/vllm': { lang: 'Python', lic: 'Apache-2.0', stars: 34000, forks: 4900, cat: 'Outils de LLM, Serving & Inférence Local' },
  'fastapi/fastapi': { lang: 'Python', lic: 'MIT', stars: 79000, forks: 6300, cat: 'Fondations & Systèmes' },
  'vitejs/vite': { lang: 'TypeScript', lic: 'MIT', stars: 71000, forks: 6100, cat: 'Fondations & Systèmes' },
  'denoland/deno': { lang: 'Rust', lic: 'MIT', stars: 94000, forks: 5300, cat: 'Fondations & Systèmes' },
  'sveltejs/svelte': { lang: 'TypeScript', lic: 'MIT', stars: 81000, forks: 4300, cat: 'Fondations & Systèmes' },
  'astral-sh/ruff': { lang: 'Rust', lic: 'MIT', stars: 35000, forks: 1200, cat: 'Agents de Codage & Génie Logiciel (SWE)' },
  'astral-sh/uv': { lang: 'Rust', lic: 'Apache-2.0', stars: 42000, forks: 1250, cat: 'Fondations & Systèmes' },
  'tokio-rs/tokio': { lang: 'Rust', lic: 'MIT', stars: 27500, forks: 2600, cat: 'Fondations & Systèmes' },
  'openai/openai-python': { lang: 'Python', lic: 'Apache-2.0', stars: 24500, forks: 3500, cat: 'Compétences Élargies, Tooling & APIs' },
  'pydantic/pydantic-ai': { lang: 'Python', lic: 'MIT', stars: 8500, forks: 750, cat: "Frameworks d'Orchestration & Multi-Agents" },
  'mem0ai/mem0': { lang: 'Python', lic: 'Apache-2.0', stars: 24500, forks: 2500, cat: 'Mémoire Étendue & RAG Avancé' },
  'run-llama/llama_index': { lang: 'Python', lic: 'MIT', stars: 37500, forks: 4800, cat: 'Mémoire Étendue & RAG Avancé' },
  'qdrant/qdrant': { lang: 'Rust', lic: 'Apache-2.0', stars: 21000, forks: 1400, cat: 'Mémoire Étendue & RAG Avancé' },
  'milvus-io/milvus': { lang: 'Go', lic: 'Apache-2.0', stars: 31000, forks: 2900, cat: 'Mémoire Étendue & RAG Avancé' },
  'chroma-core/chroma': { lang: 'Python', lic: 'Apache-2.0', stars: 16500, forks: 1300, cat: 'Mémoire Étendue & RAG Avancé' },
  'infiniflow/ragflow': { lang: 'Python', lic: 'Apache-2.0', stars: 26000, forks: 2700, cat: 'Mémoire Étendue & RAG Avancé' },
  'ray-project/ray': { lang: 'Python', lic: 'Apache-2.0', stars: 35000, forks: 5800, cat: "Frameworks d'Orchestration & Multi-Agents" },
  'huggingface/diffusers': { lang: 'Python', lic: 'Apache-2.0', stars: 27000, forks: 5600, cat: 'Modèles de Vision-Langage & Agents Multimodaux' },
  'ClickHouse/ClickHouse': { lang: 'C++', lic: 'Apache-2.0', stars: 39000, forks: 7000, cat: 'Fondations & Systèmes' },
  'Lightning-AI/pytorch-lightning': { lang: 'Python', lic: 'Apache-2.0', stars: 28800, forks: 3400, cat: 'Fondations & Systèmes' },
  'apache/arrow': { lang: 'C++', lic: 'Apache-2.0', stars: 14800, forks: 3600, cat: 'Fondations & Systèmes' }
};

function deterministicMetrics(fullName, category) {
  const digest = createHash('sha256').update(fullName).digest();
  const h1 = digest.readUInt32BE(0);
  const h2 = digest.readUInt32BE(4);
  const h3 = digest.readUInt32BE(8);

  const stars = 2500 + (h1 % 14000);
  const forks = 220 + (h2 % 1800);
  const daysAgo = (h3 % 25) + 1;

  let lang = 'Python';
  if (category.includes('Web') || category.includes('IHM')) lang = (h1 % 2 === 0) ? 'TypeScript' : 'Python';
  else if (category.includes('Systèmes') || category.includes('Inférence')) lang = ['Rust', 'Go', 'C++', 'Python'][h1 % 4];
  else if (fullName.toLowerCase().includes('rust') || fullName.toLowerCase().includes('tokio')) lang = 'Rust';
  else if (fullName.toLowerCase().includes('go')) lang = 'Go';
  else if (fullName.toLowerCase().includes('js') || fullName.toLowerCase().includes('ts')) lang = 'TypeScript';

  const lic = (h2 % 3 === 0) ? 'Apache-2.0' : 'MIT';
  return { lang, lic, stars, forks, daysAgo };
}

function upsertRepo(insertStmt, fullName, category) {
  const slashIdx = fullName.indexOf('/');
  if (slashIdx <= 0) return false;
  const owner = fullName.slice(0, slashIdx).trim();
  const name = fullName.slice(slashIdx + 1).trim();
  const sshUrl = `git@github.com:${fullName}.git`;

  // Chercher une correspondance exacte ou insensible à la casse dans FOUNDER_HEURISTICS
  const exactKey = Object.keys(FOUNDER_HEURISTICS).find(k => k.toLowerCase() === fullName.toLowerCase());
  const meta = exactKey
    ? FOUNDER_HEURISTICS[exactKey]
    : deterministicMetrics(fullName, category);

  const pushedAt = exactKey
    ? new Date(Date.now() - 2 * 86400000).toISOString()
    : new Date(Date.now() - (meta.daysAgo || 7) * 86400000).toISOString();

  const aiScore = calculateAiScore({
    stars: meta.stars,
    forks: meta.forks,
    pushedAt,
    hasDescription: true,
    license: meta.lic
  });

  const initialElo = Math.round(1400 + (aiScore * 3.5));
  const finalCategory = (exactKey && meta.cat) ? meta.cat : category;
  const description = `Dépôt de référence ${fullName} (${finalCategory}). Optimisé pour l'ingénierie et les pipelines IA.`;

  insertStmt.run(
    fullName,
    owner,
    name,
    sshUrl,
    meta.stars,
    meta.forks,
    meta.lang,
    meta.lic,
    aiScore,
    initialElo,
    pushedAt,
    description,
    finalCategory
  );
  return true;
}

export function seedDatabase(db = null) {
  const database = db || getDb();
  console.log('[SEEDER] Début de l\'ingestion des dépôts GitHub...');

  const insertRepoStmt = database.prepare(`
    INSERT INTO repositories (
      full_name, owner, name, ssh_url, stars, forks, language, license,
      ai_potential_score, elo_rating, pushed_at, description, category
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(full_name) DO UPDATE SET
      owner = excluded.owner,
      name = excluded.name,
      ssh_url = excluded.ssh_url,
      stars = excluded.stars,
      forks = excluded.forks,
      language = excluded.language,
      license = excluded.license,
      ai_potential_score = excluded.ai_potential_score,
      pushed_at = excluded.pushed_at,
      description = excluded.description,
      category = excluded.category,
      updated_at = datetime('now')
  `);

  database.exec('BEGIN TRANSACTION;');

  // Nettoyer les éventuelles anciennes entrées fictives créées par l'ancien bug owner/key
  const invalidEntries = [
    'transformers/transformers', 'pytorch/pytorch', 'next.js/next.js', 'llama.cpp/llama.cpp',
    'autogen/autogen', 'autogpt/autogpt', 'openhands/openhands', 'aider/aider',
    'crawl4ai/crawl4ai', 'firecrawl/firecrawl', 'deno/deno', 'vite/vite', 'mem0/mem0',
    'llama_index/llama_index', 'qdrant/qdrant', 'milvus/milvus', 'chroma/chroma', 'ragflow/ragflow',
    'crewai/crewai', 'langchain/langchain', 'langgraph/langgraph', 'typescript/typescript',
    'rust/rust', 'go/go', 'vllm/vllm'
  ];
  const findBadIdStmt = database.prepare('SELECT id FROM repositories WHERE full_name = ?');
  const delHarnessStmt = database.prepare('DELETE FROM harness_runs WHERE repo_id = ?');
  const delDuelsStmt = database.prepare('DELETE FROM arena_duels WHERE repo_a_id = ? OR repo_b_id = ? OR winner_id = ?');
  const deleteStmt = database.prepare('DELETE FROM repositories WHERE id = ?');
  for (const bad of invalidEntries) {
    if (!FOUNDER_HEURISTICS[bad]) {
      const row = findBadIdStmt.get(bad);
      if (row) {
        delHarnessStmt.run(row.id);
        delDuelsStmt.run(row.id, row.id, row.id);
        deleteStmt.run(row.id);
      }
    }
  }

  let insertedCount = 0;

  // 1. Lire "200 depots gitub.txt"
  const rawPath = join(__dirname, '../../200 depots gitub.txt');
  if (existsSync(rawPath)) {
    const rawText = readFileSync(rawPath, 'utf8');
    let currentCategory = 'Général';
    const lines = rawText.split('\n');

    for (const line of lines) {
      const catMatch = line.match(/"([^"]+)":\s*\[/);
      if (catMatch) {
        currentCategory = catMatch[1].trim();
        continue;
      }

      const repoMatch = line.match(/"git@github\.com:([^/]+\/[^"]+?)\.git"/);
      if (repoMatch) {
        if (upsertRepo(insertRepoStmt, repoMatch[1].trim(), currentCategory)) {
          insertedCount++;
        }
      }
    }
  }

  // 2. Ingérer les packs SSH Top 20 & Top 25 GodMod
  const packFiles = [
    join(__dirname, '../../pack_10000_depots_github_ssh/top_depots_ssh_urls.txt'),
    join(__dirname, '../../pack_1000000_depots_github_godmod_ssh/top_25_godmod_ssh_urls.txt')
  ];
  for (const packPath of packFiles) {
    if (existsSync(packPath)) {
      const lines = readFileSync(packPath, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.trim().match(/^git@github\.com:([^/]+\/[^/]+?)\.git$/);
        if (m && upsertRepo(insertRepoStmt, m[1].trim(), 'Fondations & Systèmes')) {
          insertedCount++;
        }
      }
    }
  }

  // 3. Garantir tous les dépôts fondateurs
  for (const fullName of Object.keys(FOUNDER_HEURISTICS)) {
    if (upsertRepo(insertRepoStmt, fullName, FOUNDER_HEURISTICS[fullName].cat)) {
      insertedCount++;
    }
  }

  database.exec('COMMIT;');

  const total = database.prepare('SELECT COUNT(*) as count FROM repositories').get().count;
  console.log(`[SEEDER] Ingestion réussie : ${total} dépôts uniques indexés dans la base SQLite WAL (${insertedCount} opérations).`);
  return total;
}

if (process.argv[1] && process.argv[1].endsWith('seeder.mjs')) {
  initDatabase();
  seedDatabase();
}
