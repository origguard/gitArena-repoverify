# 02-TRD : Technical Requirement Document — GitArena

## 1. Stack Technologique (Mode Souverain Zero-NPM)
- **Runtime** : Node.js v24.19.0+ natif ESM (`"type": "module"`).
- **Moteur de Données** : `node:sqlite` natif (`DatabaseSync`) configuré en mode WAL (`PRAGMA journal_mode = WAL`) et index FTS5 pour la recherche plein-texte sub-milliseconde.
- **Cryptographie & Intégrité** : `node:crypto` natif (WebCrypto, SHA-256, HMAC, Ed25519).
- **Serveur Web HTTP** : `node:http` natif avec routage déclaratif REST et gestionnaire de streaming d'événements.
- **Frontend & IHM** : HTML5 sémantique, CSS3 moderne (Variables, Flexbox, Grid, GPU Transforms), JS Vanilla ultra-léger sans transpileur ni runtime tiers.
- **Harnais de Validation** : `node:test` et `node:assert/strict` natifs pour exécution déterministe à code de sortie 0.
- **Dépendances NPM externes** : **Strictement 0 (zéro octet d'egress, zéro vulnérabilité supply-chain)**.

## 2. Arborescence du Projet
```
github porject/
├── docs/                                  # Référentiel normatif en 8 documents
│   ├── 01-PRD.md
│   ├── 02-TRD.md
│   ├── 03-APPFLOW.md
│   ├── 04-UI-UX-DESIGN.md
│   ├── 05-BACKEND-SCHEMA.md
│   ├── 06-IMPLEMENTATION-PLAN.md
│   ├── 07-SECURITY-AND-COMPLIANCE.md
│   └── 08-VERIFICATION-HARNESS.md
├── src/                                   # Cœur applicatif souverain
│   ├── db/                                # Couche de persistance SQLite WAL
│   │   ├── schema.sql                     # DDL SQLite (Tables, Index, FTS5)
│   │   ├── database.mjs                   # Wrapper DatabaseSync natif Node.js
│   │   └── seeder.mjs                     # Ingestion des packs 200, 10k et 1M
│   ├── engines/                           # Moteurs de calcul et d'évaluation
│   │   ├── elo-engine.mjs                 # Moteur de cotation ELO pour duels
│   │   ├── ai-scoring-engine.mjs          # Calcul du score IA composite (/100)
│   │   └── harness-runner.mjs             # Exécuteur de tests déterministe (pass@k)
│   ├── workflows/                         # Automatisation événementielle
│   │   └── workflow-engine.mjs            # Ordonnanceur de tâches et sync
│   ├── server/                            # Serveur HTTP & API REST
│   │   ├── router.mjs                     # Moteur de routage et middlewares
│   │   ├── controllers.mjs                # Contrôleurs métier (Arena, Search, Badges)
│   │   └── server.mjs                     # Point d'entrée HTTP
│   └── public/                            # Assets statiques livrés à l'IHM
│       ├── css/
│       │   └── theme.css                  # Design Tokens Cyber-Industrial
│       ├── js/
│       │   └── app.js                     # Logique d'interaction et 4 états UI
│       └── index.html                     # Interface applicative unique (SPA ultra-rapide)
├── tests/                                 # Harnais de test déterministe
│   └── test-gitarena-e2e.mjs              # Test end-to-end complet avec exit code 0
└── package.json                           # Définition de package ("type": "module")
```

## 3. Gestion d'État, Contrats de Données & Validation
- **Validation Systématique** : Tout paramètre entrant d'URL ou corps de requête JSON est validé contre un schéma de types stricts (`string`, `integer`, `regex` pour noms de dépôts `^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`).
- **Idempotence & Transactions** : Les votes de duels et les mises à jour ELO sont encapsulés dans des transactions SQLite atomiques (`BEGIN IMMEDIATE ... COMMIT`).
- **Mise en Cache Mémoire** : Mise en cache LRU native des requêtes FTS5 fréquentes et des badges SVG pour garantir une latence sous 150 µs.

## 4. Performance & Budgets
- **Temps de Réponse API** : $< 15\text{ ms}$ au 99e percentile (P99) pour la recherche.
- **Empreinte Mémoire** : $< 85\text{ Mo}$ de RAM active au démarrage, $< 200\text{ Mo}$ lors d'une charge de 500 req/s.
- **Lighthouse Metrics** : Performance 100/100, Accessibilité 100/100, Best Practices 100/100, SEO 100/100.
