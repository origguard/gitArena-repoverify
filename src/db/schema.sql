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

-- 11. Pilier 1 : Audits Comportementaux Statiques (Pre-Flight)
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

-- 11b. Faits Comportementaux Séparés du Verdict (Runbook §4.4 & III §14)
CREATE TABLE IF NOT EXISTS behavioral_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    commit_sha TEXT,
    scan_mode TEXT NOT NULL CHECK (scan_mode IN ('METADATA_ONLY', 'STATIC')),
    scan_scope TEXT,
    ref TEXT,
    findings_json TEXT NOT NULL DEFAULT '[]',
    scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
    scanner_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facts_repo ON behavioral_facts(owner, name, scanned_at DESC);

-- 12. Pilier 2 : Registre de Signatures d'Intégrité Ed25519
CREATE TABLE IF NOT EXISTS integrity_signatures (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    subject_repo_id INTEGER,
    policy_profile TEXT NOT NULL,
    decision TEXT NOT NULL,
    trust_score INTEGER NOT NULL,
    evidence_level INTEGER DEFAULT 1,
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    keyid TEXT,
    expires_at TEXT,
    violations_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    signature_ed25519 TEXT NOT NULL,
    public_key_pem TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    issued_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integrity_repo ON integrity_signatures(full_name);

-- 12b. Registre de Clés Révoquées (Runbook §1.3)
CREATE TABLE IF NOT EXISTS revoked_keys (
    keyid TEXT PRIMARY KEY,
    revoked_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    supersedes TEXT
);

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

-- 15. Phase III (§13) : Entrées du corpus à résoudre par l'indexeur (statut & attrition)
CREATE TABLE IF NOT EXISTS corpus_inputs (
    input TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    resolved_id INTEGER,
    last_error TEXT,
    attempted_at TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 16. Phase III (§13) : Dépôts résolus canoniquement par ID numérique GitHub + identité
CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL UNIQUE,
    default_branch TEXT NOT NULL DEFAULT 'main',
    archived INTEGER NOT NULL DEFAULT 0,
    fork INTEGER NOT NULL DEFAULT 0,
    stars INTEGER NOT NULL DEFAULT 0,
    language TEXT,
    license TEXT,
    pushed_at TEXT,
    identity_json TEXT,
    resolved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_repos_canon_full ON repos(full_name);

-- 17. Phase III (§14) : Cache de manifestes & sonde manifest_probe
CREATE TABLE IF NOT EXISTS manifest_cache (
    full_name TEXT PRIMARY KEY,
    blobs_json TEXT NOT NULL,
    scope TEXT NOT NULL,
    manifest_probe_json TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 18. Phase III (§15) : Interrogations OSV.dev datées & référencées (niveaux 2 vs 3)
CREATE TABLE IF NOT EXISTS osv_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    ecosystem TEXT NOT NULL,
    packages INTEGER NOT NULL,
    vulns_json TEXT NOT NULL DEFAULT '[]',
    queried_at TEXT NOT NULL,
    ref TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('queried', 'no_pinned_deps', 'error')),
    deps_declared INTEGER,
    deps_resolved INTEGER,
    deps_queried INTEGER,
    lockfile_used TEXT,
    coverage_gate TEXT
);

CREATE INDEX IF NOT EXISTS idx_osv_queries_repo ON osv_queries(owner, name, queried_at DESC);

-- 19. Phase III (§16) : Historique des exécutions de l'indexeur (scan_runs)
CREATE TABLE IF NOT EXISTS scan_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    stage TEXT NOT NULL,
    fetch_mode TEXT,
    cohort_id TEXT,
    resolved INTEGER DEFAULT 0,
    ghosts INTEGER DEFAULT 0,
    dupes INTEGER DEFAULT 0,
    scanned INTEGER DEFAULT 0,
    osv_ok INTEGER DEFAULT 0,
    api_calls INTEGER DEFAULT 0,
    failures TEXT DEFAULT '[]'
);

-- 20. Phase IV (§21) : Cohortes datées (un dénominateur figé par échantillon)
CREATE TABLE IF NOT EXISTS cohort_members (
    cohort_id TEXT NOT NULL,
    repo_id INTEGER,
    input TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (cohort_id, input)
);

CREATE INDEX IF NOT EXISTS idx_cohort_members_cohort ON cohort_members(cohort_id);

-- 21. Phase IV (§18) : Attrition nommée entre étages (zéro perte silencieuse)
CREATE TABLE IF NOT EXISTS stage_attrition (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cohort_id TEXT,
    repo_id INTEGER,
    input TEXT NOT NULL,
    from_stage TEXT NOT NULL,
    to_stage TEXT NOT NULL,
    reason TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stage_attrition_cohort ON stage_attrition(cohort_id, from_stage, to_stage);

-- 22. Phase V (§23) : Traçabilité de profondeur de sonde (origine 'probe' vs 'repo')
CREATE TABLE IF NOT EXISTS probe_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cohort_id TEXT,
    repo_id INTEGER,
    full_name TEXT NOT NULL,
    consulted INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    locks_found_json TEXT NOT NULL DEFAULT '[]',
    locks_read_json TEXT NOT NULL DEFAULT '[]',
    cause TEXT,
    origin TEXT,
    gate TEXT NOT NULL,
    cap TEXT NOT NULL,
    scope_statement TEXT,
    probed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_probe_outcomes_repo ON probe_outcomes(full_name, probed_at DESC);
