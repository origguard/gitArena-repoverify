# 05-BACKEND-SCHEMA : Schéma de Base de Données & Contrats d'API — GitArena

## 1. Schéma Relationnel & Tables Virtuelles SQLite WAL

Le moteur de stockage repose sur `node:sqlite` natif en mode WAL (`Write-Ahead Logging`), exploitant des index B-Tree pour les requêtes ordonnées et une table virtuelle FTS5 pour l'indexation plein-texte ultra-rapide.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- 1. Table Maîtresse des Dépôts
CREATE TABLE IF NOT EXISTS repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL UNIQUE,          -- ex: 'huggingface/transformers'
    owner TEXT NOT NULL,                     -- ex: 'huggingface'
    name TEXT NOT NULL,                      -- ex: 'transformers'
    ssh_url TEXT NOT NULL,                   -- ex: 'git@github.com:huggingface/transformers.git'
    stars INTEGER NOT NULL DEFAULT 0,
    forks INTEGER NOT NULL DEFAULT 0,
    language TEXT NOT NULL,                  -- ex: 'Python'
    license TEXT NOT NULL,                  -- ex: 'Apache-2.0'
    ai_potential_score REAL NOT NULL,       -- Calculé sur 100
    elo_rating INTEGER NOT NULL DEFAULT 1500, -- Score ELO pour l'arène
    pushed_at TEXT NOT NULL,                 -- Date ISO dernier commit
    description TEXT,
    category TEXT NOT NULL DEFAULT 'Général',-- Pôle technologique
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index de performance B-Tree
CREATE INDEX IF NOT EXISTS idx_repos_language ON repositories(language);
CREATE INDEX IF NOT EXISTS idx_repos_ai_score ON repositories(ai_potential_score DESC);
CREATE INDEX IF NOT EXISTS idx_repos_elo ON repositories(elo_rating DESC);
CREATE INDEX IF NOT EXISTS idx_repos_license ON repositories(license);
CREATE INDEX IF NOT EXISTS idx_repos_category ON repositories(category);

-- 2. Table Virtuelle FTS5 pour Recherche Plein-Texte Ultra-Rapide (< 5 ms)
CREATE VIRTUAL TABLE IF NOT EXISTS repositories_fts USING fts5(
    full_name,
    description,
    language,
    category,
    content='repositories',
    content_rowid='id'
);

-- Triggers de Synchronisation Automatique FTS5
CREATE TRIGGER IF NOT EXISTS trig_repos_ai AFTER INSERT ON repositories BEGIN
    INSERT INTO repositories_fts(rowid, full_name, description, language, category)
    VALUES (new.id, new.full_name, new.description, new.language, new.category);
END;

CREATE TRIGGER IF NOT EXISTS trig_repos_ad AFTER DELETE ON repositories BEGIN
    INSERT INTO repositories_fts(repositories_fts, rowid, full_name, description, language, category)
    VALUES ('delete', old.id, old.full_name, old.description, old.language, old.category);
END;

CREATE TRIGGER IF NOT EXISTS trig_repos_au AFTER UPDATE ON repositories BEGIN
    INSERT INTO repositories_fts(repositories_fts, rowid, full_name, description, language, category)
    VALUES ('delete', old.id, old.full_name, old.description, old.language, old.category);
    INSERT INTO repositories_fts(rowid, full_name, description, language, category)
    VALUES (new.id, new.full_name, new.description, new.language, new.category);
END;

-- 3. Table des Duels & Historique ELO
CREATE TABLE IF NOT EXISTS arena_duels (
    id TEXT PRIMARY KEY,                     -- UUID v4 ou digest SHA-256
    repo_a_id INTEGER NOT NULL REFERENCES repositories(id),
    repo_b_id INTEGER NOT NULL REFERENCES repositories(id),
    winner_id INTEGER REFERENCES repositories(id), -- NULL si match nul
    repo_a_elo_before INTEGER NOT NULL,
    repo_b_elo_before INTEGER NOT NULL,
    repo_a_elo_after INTEGER NOT NULL,
    repo_b_elo_after INTEGER NOT NULL,
    voter_fingerprint TEXT,                 -- Empreinte SHA-256 anti-bourrage
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_duels_repo_a ON arena_duels(repo_a_id);
CREATE INDEX IF NOT EXISTS idx_duels_repo_b ON arena_duels(repo_b_id);

-- 4. Table des Exécutions du Harnais (Harness Runs)
CREATE TABLE IF NOT EXISTS harness_runs (
    id TEXT PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repositories(id),
    test_suite TEXT NOT NULL,               -- ex: 'syntax-and-imports', 'pass-at-k'
    exit_code INTEGER NOT NULL DEFAULT 0,    -- 0 = Succès mécanique absolu
    pass_rate REAL NOT NULL DEFAULT 1.0,     -- Ratio 0.0 à 1.0
    latency_ms REAL NOT NULL,
    ram_usage_mb REAL NOT NULL,
    receipt_blake3 TEXT NOT NULL,            -- Preuve cryptographique
    executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_harness_repo ON harness_runs(repo_id);
```

---

## 2. Contrats d'API REST

### `GET /api/repos`
- **Requête** :
  - `q` : Chaîne de recherche FTS5 (optionnel).
  - `lang` : Filtre langage (optionnel).
  - `category` : Filtre catégorie (optionnel).
  - `limit` : Nombre d'éléments (défaut: 20, max: 100).
  - `offset` : Décalage pagination (défaut: 0).
  - `sort` : Critère de tri (`ai_score`, `elo`, `stars`, `pushed_at`).
- **Réponse (200 OK)** :
```json
{
  "total": 10000,
  "limit": 20,
  "offset": 0,
  "query_time_ms": 2.45,
  "items": [
    {
      "id": 1,
      "full_name": "huggingface/transformers",
      "owner": "huggingface",
      "name": "transformers",
      "stars": 138000,
      "forks": 26500,
      "language": "Python",
      "license": "Apache-2.0",
      "ai_potential_score": 98.85,
      "elo_rating": 1845,
      "category": "Intelligence Artificielle & Data Science",
      "pushed_at": "2026-10-20T14:30:00Z"
    }
  ]
}
```

### `GET /api/arena/duel`
- **Réponse (200 OK)** :
```json
{
  "duel_id": "duel_7f8a9b1c2d3e",
  "challenger_a": {
    "id": 10,
    "full_name": "langchain-ai/langchain",
    "stars": 92000,
    "elo_rating": 1650,
    "language": "Python",
    "ai_potential_score": 96.80
  },
  "challenger_b": {
    "id": 12,
    "full_name": "run-llama/llama_index",
    "stars": 38000,
    "elo_rating": 1642,
    "language": "Python",
    "ai_potential_score": 95.40
  }
}
```

### `POST /api/arena/vote`
- **Corps de Requête** :
```json
{
  "duel_id": "duel_7f8a9b1c2d3e",
  "winner": "challenger_a" // "challenger_a" | "challenger_b" | "tie"
}
```
- **Réponse (200 OK)** :
```json
{
  "status": "success",
  "updated_a": { "id": 10, "new_elo": 1666, "delta": 16 },
  "updated_b": { "id": 12, "new_elo": 1626, "delta": -16 }
}
```
