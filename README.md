# RepoVerify / GitArena

[![RepoVerify / GitArena CI](https://github.com/origguard/gitArena-repoverify/actions/workflows/ci.yml/badge.svg)](https://github.com/origguard/gitArena-repoverify/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-00ff88.svg)](https://nodejs.org/)

**Moteur d'Inspection Chirurgicale, Due-Diligence Open-Source, Arène ELO & Serveur MCP pour dépôts GitHub.**

> **100 % Node.js ESM natif** • **Zéro dépendance NPM externe** • **SQLite WAL + FTS5 sub-milliseconde** • **Audit Supply-Chain OSV.dev & CI/CD en direct**

---

## Pourquoi RepoVerify / GitArena ?

Sur GitHub, le nombre d'étoiles (*star vanity metrics*) ne prouve ni la fiabilité, ni la maintenabilité, ni la conformité légale d'un dépôt. **RepoVerify / GitArena** remplace les vérifications manuelles par un cockpit souverain :

1. **Inspection Chirurgicale & CI/CD Réelle** : vérifie l'activité réelle, les derniers runs **GitHub Actions**, l'indexation **Just-In-Time (JIT)** de n'importe quel dépôt public (`owner/repo`, HTTPS ou SSH) et génère des quittances signées SHA-256.
2. **Audit Juridique BigCode / The Stack v2** : contrôle les licences permissives (`MIT`, `Apache-2.0`, `BSD`, `ISC`, `0BSD`, `Unlicense`) pour éviter toute contamination virale *copyleft* en production ou lors de l'entraînement de modèles d'IA.
3. **Code Intelligence & Supply-Chain (OSV.dev)** : analyse sans clonage via **GitIngest** (avec fallback **GitHub Trees API**), extrait les dépendances (`npm`, `pip`, `Cargo.toml`, `go.mod`), détecte les lockfiles et scanne les CVE connues via **OSV.dev**.
4. **Sandbox Docker Isolé (`Exit Code 0`)** : clone en `--depth 1` et exécute la suite de tests dans un conteneur isolé (`--network=none --memory=1024m --cpus=1 --pids-limit=64`), avec persistance dans `harness_runs`.
5. **Arène & Comparateur ELO** : confrontez deux projets côte-à-côte et arbitrez le classement ELO ($K=32$) avec persistance dans `arena_duels`.
6. **Radar Tactique God's Eye & PixelRAG** : cartographie vectorielle SVG des architectures et projection spatiale par grappes technologiques.
7. **Serveur MCP Natif (`stdio` JSON-RPC 2.0)** : connectez directement vos assistants de code (Antigravity, Cursor, Claude Code) pour auditer les bibliothèques avant de les installer.

---

## Démarrage Rapide (3 Commandes)

**Prérequis :** Node.js `>= 22.0.0` (testé sur Node.js `24.x`, module natif `node:sqlite`).

```bash
# 1. Initialiser et peupler la base SQLite WAL + FTS5
npm run seed

# 2. Exécuter le harnais de vérification E2E complet
npm test

# 3. Lancer l'interface web et l'API REST (http://localhost:8080)
npm start
```

*(Optionnel)* Copiez `.env.example` vers `.env` et renseignez `GITHUB_TOKEN` pour passer de 60 à 5 000 requêtes/heure sur l'API GitHub.

---

## Utilisation Avancée

### 1. Pipeline d'Ingestion Hyperscale (`npm run ingest`)
Peuplez la base à partir de listes SSH ou directement en moissonnant l'API GitHub Search :

```bash
# Moissonner des dépôts réels depuis GitHub (ex: Python, >= 1000 stars, licences permissives)
node src/db/bulk-ingestor.mjs --harvest --pages 5 --min-stars 1000 --lang Python --permissive

# Importer un fichier de URLs SSH (.txt ou .md) en transaction SQLite WAL
node src/db/bulk-ingestor.mjs --file pack_10000_depots_github_ssh/top_depots_ssh_urls.txt
```

### 2. Vérification Sandbox Isolée (`npm run verify`)
Exécute les tests réels d'un dépôt dans un conteneur Docker sans accès réseau (`--network=none`) :

```bash
node src/engines/sandbox-runner.mjs fastapi/fastapi
```

### 3. Intégration MCP dans votre IDE / Agent IA
Ajoutez la configuration suivante dans votre client MCP (Antigravity, Cursor, Claude Desktop) :

```json
{
  "mcpServers": {
    "repoverify": {
      "command": "node",
      "args": ["/chemin/absolu/vers/src/mcp/mcp-server.mjs"]
    }
  }
}
```

Outils MCP exposés : `search_repos`, `inspect_repo`, `get_codeintel`, `compare_repos`.

---

## Architecture du Projet

```text
├── docs/                  # Spécifications d'architecture (01-PRD à 08-VERIFICATION-HARNESS)
├── src/
│   ├── db/                # Schéma SQLite WAL/FTS5, Seeder déterministe & Bulk Ingestor
│   ├── engines/           # AI Scoring, ELO, CI Telemetry, OSV Scanner, GitIngest, PixelRAG, God's Eye, Sandbox
│   ├── mcp/               # Serveur Model Context Protocol (stdio JSON-RPC 2.0)
│   ├── public/            # SPA Vanilla JS/CSS (Inspecteur, Arène, Radar, Explorateur FTS5)
│   ├── server/            # Serveur HTTP souverain, routeur anti-traversal et contrôleurs REST
│   └── workflows/         # Moteur d'automatisation TCA avec journalisation SHA-256
├── tests/                 # Harnais de vérification E2E complet (process.exit(0))
└── .github/workflows/     # Pipeline CI GitHub Actions
```

---

## Licence

Distribué sous licence **Apache-2.0**. Voir [LICENSE](LICENSE) pour plus d'informations.
