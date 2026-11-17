-- GitArena Sovereign SQLite Schema (WAL Mode + FTS5)
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- 1. Table des Dépôts GitHub
CREATE TABLE IF NOT EXISTS repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    ssh_url TEXT NOT NULL,
    stars INTEGER NOT NULL DEFAULT 0,
    forks INTEGER NOT NULL DEFAULT 0,
    language TEXT NOT NULL,
    license TEXT NOT NULL,
    ai_potential_score REAL NOT NULL,
    elo_rating INTEGER NOT NULL DEFAULT 1500,
    pushed_at TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'Général',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_repos_language ON repositories(language);
CREATE INDEX IF NOT EXISTS idx_repos_ai_score ON repositories(ai_potential_score DESC);
CREATE INDEX IF NOT EXISTS idx_repos_elo ON repositories(elo_rating DESC);
CREATE INDEX IF NOT EXISTS idx_repos_license ON repositories(license);
CREATE INDEX IF NOT EXISTS idx_repos_category ON repositories(category);

-- 2. Table Virtuelle FTS5 pour Recherche Plein-Texte (< 5 ms)
CREATE VIRTUAL TABLE IF NOT EXISTS repositories_fts USING fts5(
    full_name,
    description,
    language,
    category,
    content='repositories',
    content_rowid='id'
);

-- Triggers de Synchronisation FTS5
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
    id TEXT PRIMARY KEY,
    repo_a_id INTEGER NOT NULL REFERENCES repositories(id),
    repo_b_id INTEGER NOT NULL REFERENCES repositories(id),
    winner_id INTEGER REFERENCES repositories(id),
    repo_a_elo_before INTEGER NOT NULL,
    repo_b_elo_before INTEGER NOT NULL,
    repo_a_elo_after INTEGER NOT NULL,
    repo_b_elo_after INTEGER NOT NULL,
    voter_fingerprint TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_duels_repo_a ON arena_duels(repo_a_id);
CREATE INDEX IF NOT EXISTS idx_duels_repo_b ON arena_duels(repo_b_id);

-- 4. Table des Exécutions du Harnais
CREATE TABLE IF NOT EXISTS harness_runs (
    id TEXT PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repositories(id),
    test_suite TEXT NOT NULL,
    exit_code INTEGER NOT NULL DEFAULT 0,
    pass_rate REAL NOT NULL DEFAULT 1.0,
    latency_ms REAL NOT NULL,
    ram_usage_mb REAL NOT NULL,
    receipt_blake3 TEXT NOT NULL,
    executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_harness_repo ON harness_runs(repo_id);

-- 5. Cache GitIngest Deep Scan (évite de re-requêter pour chaque visite)
CREATE TABLE IF NOT EXISTS gitingest_cache (
    full_name TEXT PRIMARY KEY,
    files_analyzed INTEGER NOT NULL DEFAULT 0,
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    commit_hash TEXT,
    maturity_score INTEGER NOT NULL DEFAULT 0,
    tree_preview TEXT,
    project_health_json TEXT,
    dependencies_json TEXT,
    digest_url TEXT,
    top_level_dirs INTEGER NOT NULL DEFAULT 0,
    total_tree_lines INTEGER NOT NULL DEFAULT 0,
    digest_hash TEXT NOT NULL,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 6. Cache Télémétrie CI/CD GitHub Actions (expiration 6h)
CREATE TABLE IF NOT EXISTS ci_telemetry_cache (
    full_name TEXT PRIMARY KEY,
    actions_json TEXT NOT NULL,
    ci_pass_rate REAL,
    last_run_status TEXT,
    last_run_at TEXT,
    workflows_count INTEGER NOT NULL DEFAULT 0,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 7. Cache Vulnérabilités OSV.dev (expiration 24h)
CREATE TABLE IF NOT EXISTS osv_vuln_cache (
    ecosystem TEXT NOT NULL,
    package_name TEXT NOT NULL,
    vulns_json TEXT NOT NULL,
    vuln_count INTEGER NOT NULL DEFAULT 0,
    max_severity TEXT NOT NULL DEFAULT 'NONE',
    cached_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (ecosystem, package_name)
);

-- 8. Journal d'Audit des Workflows Autonomes (TCA)
CREATE TABLE IF NOT EXISTS workflow_audit_log (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms REAL NOT NULL,
    seal TEXT NOT NULL,
    payload_json TEXT,
    executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 9. Cache Santé Mainteneurs & Bus Factor (expiration 12h)
CREATE TABLE IF NOT EXISTS maintainer_health_cache (
    full_name TEXT PRIMARY KEY,
    contributors_count INTEGER NOT NULL DEFAULT 0,
    top_contributor_share REAL NOT NULL DEFAULT 100,
    latest_release_tag TEXT,
    latest_release_at TEXT,
    bus_factor_risk TEXT NOT NULL DEFAULT 'MODERATE',
    raw_json TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 10. Historique des Tournois Multi-Dépôts (4 à 8 candidats)
CREATE TABLE IF NOT EXISTS arena_tournaments (
    id TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    category TEXT,
    repos_json TEXT NOT NULL,
    stages_json TEXT NOT NULL,
    winner_full_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 11. Pilier 1 : Audits Comportementaux (Runtime Behavioral Firewall)
CREATE TABLE IF NOT EXISTS behavioral_audits (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    verdict TEXT NOT NULL,
    risk_score INTEGER NOT NULL DEFAULT 0,
    findings_json TEXT NOT NULL,
    scan_mode TEXT NOT NULL,
    receipt_sha256 TEXT NOT NULL,
    scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_behavior_repo ON behavioral_audits(full_name);

-- 12. Pilier 2 : Registre de Confiance Signé Ed25519 (Trust Registry)
CREATE TABLE IF NOT EXISTS trust_attestations (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    policy_profile TEXT NOT NULL,
    decision TEXT NOT NULL,
    trust_score INTEGER NOT NULL,
    violations_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    signature_ed25519 TEXT NOT NULL,
    public_key_pem TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    issued_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trust_repo ON trust_attestations(full_name);

-- 13. Pilier 3 : Benchmarks d'Exécution Chronométrés
CREATE TABLE IF NOT EXISTS execution_benchmarks (
    id TEXT PRIMARY KEY,
    repo_full_name TEXT NOT NULL,
    suite_name TEXT NOT NULL,
    cold_start_ms REAL NOT NULL,
    throughput_ops REAL NOT NULL DEFAULT 0,
    peak_ram_mb REAL NOT NULL,
    exit_code INTEGER NOT NULL DEFAULT 0,
    env_fingerprint TEXT NOT NULL,
    receipt_sha256 TEXT NOT NULL,
    executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_exec_bench_repo ON execution_benchmarks(repo_full_name);

-- 14. Pilier 4 : Politiques d'Organisation & Licences Open-Core
CREATE TABLE IF NOT EXISTS org_policies (
    org_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL DEFAULT 'community',
    policy_json TEXT NOT NULL,
    license_token TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
