import { createInterface } from 'node:readline';
import { initDatabase, closeDatabase } from '../db/database.mjs';
import {
  searchRepositories,
  inspectRepository,
  inspectCodeIntelligence,
  getArenaDuel
} from '../engines/repo-service.mjs';
import { runMultiRepoTournament } from '../engines/tournament-engine.mjs';

/**
 * Serveur MCP Souverain (Model Context Protocol) sur stdio (JSON-RPC 2.0)
 * 100% Natif Node.js ESM, zéro dépendance externe.
 * Expose les outils d'audit, de recherche FTS5, d'analyse OSV et de comparaison aux agents IA / IDE.
 */

const SERVER_INFO = {
  name: 'repoverify-gitarena',
  version: '3.1.0'
};

const TOOLS = [
  {
    name: 'search_repos',
    description: 'Recherche plein-texte FTS5 sub-10ms dans le corpus RepoVerify/GitArena avec filtres par langage, catégorie et licence permissive.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Requête de recherche plein-texte (ex: transformers, agent, rag)' },
        lang: { type: 'string', description: 'Langage de programmation (ex: Python, Rust, TypeScript, Go)' },
        category: { type: 'string', description: 'Catégorie technologique' },
        license: { type: 'string', description: "Filtrer par licence ('permissive' pour MIT/Apache-2.0/BSD uniquement)" },
        sort: { type: 'string', enum: ['ai_score', 'elo', 'stars', 'name'], description: 'Critère de tri' },
        limit: { type: 'number', description: 'Nombre max de résultats (1-50, défaut 10)' }
      }
    }
  },
  {
    name: 'inspect_repo',
    description: 'Effectue une inspection chirurgicale complète d\'un dépôt GitHub (santé CI/CD GitHub Actions, audit juridique BigCode/Commercial-Safe, indexation JIT si absent, quickstart).',
    inputSchema: {
      type: 'object',
      required: ['repo'],
      properties: {
        repo: { type: 'string', description: 'Dépôt au format owner/name (ex: huggingface/transformers)' },
        includeLiveCi: { type: 'boolean', description: 'Interroger GitHub Actions API en direct (défaut: true)' }
      }
    }
  },
  {
    name: 'get_codeintel',
    description: 'Extrait l\'arbre de fichiers, les dépendances (npm/pip/Cargo/Go), les lockfiles, la compatibilité contexte LLM et le scan de vulnérabilités CVE via OSV.dev.',
    inputSchema: {
      type: 'object',
      required: ['repo'],
      properties: {
        repo: { type: 'string', description: 'Dépôt au format owner/name (ex: langchain-ai/langchain)' }
      }
    }
  },
  {
    name: 'compare_repos',
    description: 'Compare deux dépôts GitHub côte-à-côte (Score IA, ELO, Stars, Fraîcheur, Licence commerciale).',
    inputSchema: {
      type: 'object',
      required: ['repoA', 'repoB'],
      properties: {
        repoA: { type: 'string', description: 'Premier dépôt (owner/name)' },
        repoB: { type: 'string', description: 'Second dépôt (owner/name)' }
      }
    }
  },
  {
    name: 'run_tournament',
    description: 'Exécute un tournoi Survival multi-dépôts (4 à 8 candidats) avec élimination par étapes et pondération selon le profil métier (enterprise, startup, ai_training, balanced).',
    inputSchema: {
      type: 'object',
      properties: {
        repos: { type: 'array', items: { type: 'string' }, description: 'Liste de 4 à 8 dépôts owner/name (optionnel si category fournie)' },
        category: { type: 'string', description: 'Catégorie technologique à évaluer si repos non fournis' },
        profile: { type: 'string', enum: ['enterprise', 'startup', 'ai_training', 'balanced'], description: 'Profil de pondération métier (défaut: enterprise)' },
        limit: { type: 'number', description: 'Nombre de candidats (4 à 8, défaut 6)' }
      }
    }
  }
];

function writeResponse(id, result) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`${payload}\n`);
}

function writeError(id, code, message) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`${payload}\n`);
}

function parseOwnerName(repoSlug = '') {
  const clean = String(repoSlug)
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .trim();
  const parts = clean.split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { owner: parts[0], name: parts[1] };
}

export async function handleMcpRequest(msg) {
  const { id, method, params } = msg;

  // Notifications sans id (ex: notifications/initialized)
  if (id === undefined || id === null) {
    return null;
  }

  if (method === 'initialize') {
    return writeResponse(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO
    });
  }

  if (method === 'ping') {
    return writeResponse(id, {});
  }

  if (method === 'tools/list') {
    return writeResponse(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    try {
      let resultObj = null;

      if (toolName === 'search_repos') {
        resultObj = searchRepositories({
          q: args.q,
          lang: args.lang,
          category: args.category,
          license: args.license,
          sort: args.sort,
          limit: Math.min(50, args.limit || 10)
        });
      } else if (toolName === 'inspect_repo') {
        const parsed = parseOwnerName(args.repo);
        if (!parsed) {
          return writeResponse(id, {
            isError: true,
            content: [{ type: 'text', text: 'Format invalide : utilisez owner/name (ex: huggingface/transformers)' }]
          });
        }
        const insp = await inspectRepository(parsed.owner, parsed.name, {
          includeLiveCi: args.includeLiveCi !== false,
          persistHarness: false
        });
        if (!insp.ok) {
          return writeResponse(id, {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(insp.payload, null, 2) }]
          });
        }
        resultObj = insp.payload;
      } else if (toolName === 'get_codeintel') {
        const parsed = parseOwnerName(args.repo);
        if (!parsed) {
          return writeResponse(id, {
            isError: true,
            content: [{ type: 'text', text: 'Format invalide : utilisez owner/name' }]
          });
        }
        resultObj = await inspectCodeIntelligence(parsed.owner, parsed.name);
      } else if (toolName === 'compare_repos') {
        const duel = getArenaDuel({ repoA: args.repoA, repoB: args.repoB });
        if (!duel) {
          return writeResponse(id, {
            isError: true,
            content: [{ type: 'text', text: 'Impossible de comparer ces deux dépôts (introuvables en base).' }]
          });
        }
        resultObj = duel;
      } else if (toolName === 'run_tournament') {
        resultObj = await runMultiRepoTournament({
          repos: Array.isArray(args.repos) ? args.repos : [],
          category: args.category || '',
          profile: args.profile || 'enterprise',
          limit: args.limit || 6,
          includeLiveChecks: args.includeLiveChecks !== false
        });
      } else {
        return writeError(id, -32601, `Outil MCP inconnu : ${toolName}`);
      }

      return writeResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(resultObj, null, 2) }]
      });
    } catch (err) {
      return writeResponse(id, {
        isError: true,
        content: [{ type: 'text', text: `Erreur d'exécution MCP : ${err.message}` }]
      });
    }
  }

  return writeError(id, -32601, `Méthode non supportée : ${method}`);
}

export function startMcpServer() {
  initDatabase();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      await handleMcpRequest(msg);
    } catch (err) {
      writeError(null, -32700, `JSON-RPC Parse Error: ${err.message}`);
    }
  });

  rl.on('close', () => {
    closeDatabase();
    process.exit(0);
  });
}

if (process.argv[1] && process.argv[1].endsWith('mcp-server.mjs')) {
  startMcpServer();
}
