# 01-PRD : Product Requirement Document — GitArena

## 1. Aperçu Exécutif (Executive Overview)
**GitArena** est la première plateforme mondiale de benchmarking vivant et d'exploration hyperscale pour **1 000 000 de dépôts GitHub** open source à fort potentiel. En rupture avec les classements superficiels basés uniquement sur le nombre d'étoiles GitHub ("star vanity metrics"), GitArena introduit une arène dialectique et automatisée inspirée de LMSYS Chatbot Arena et des bancs de test automatisés : chaque framework et bibliothèque est évalué en conditions réelles d'exécution (code de sortie 0, latence, consommation mémoire, pass@k, compatibilité licence pour l'entraînement d'IA).

## 2. Objectifs & Personas Cibles
- **Volume Cible** : 1 000 000+ utilisateurs uniques mensuels (développeurs, chercheurs IA, ingénieurs données, créateurs de startups, mainteneurs open source).
- **Personas** :
  1. *L'Ingénieur IA / SWE* : Cherche le framework le plus fiable et maintenu pour sa pile de production (ex: *LangGraph* vs *CrewAI*, *vLLM* vs *Ollama*).
  2. *Le Créateur de Modèles / LLM Trainer* : Recherche des bases de code massives avec licences strictement permissives (`MIT`, `Apache-2.0`, `BSD`) exemptes de risques viraux de copyleft (conforme BigCode The Stack v2).
  3. *Le Mainteneur Open Source* : Veut prouver la supériorité technique et la robustesse de son projet via un badge dynamique vérifié inséré dans son `README.md`.

## 3. Exigences Fonctionnelles

### P0 — MVP Critique (Lancement Immédiat)
- **F1 : Moteur d'Exploration Hyperscale Instantané**
  - Indexation et recherche plein-texte (< 10 ms) sur le corpus des 10 000 et 1 000 000 dépôts via SQLite WAL et FTS5.
  - Filtres multidimensionnels : Langage (40 langages supportés), Pôle technologique (IA, Systèmes, Web, Cloud, etc.), Licence SPDX vérifiée, Tranche de Score IA (0-100).
- **F2 : L'Arène des Duels en Direct (GitArena Battles)**
  - Sélection de deux dépôts concurrents pour confrontation directe (ex: `langchain-ai/langchain` vs `run-llama/llama_index`, `browser-use/browser-use` vs `unclecode/crawl4ai`).
  - Terminal de restitution du duel : exécution de scénarios standardisés (`harness-engineering`), restitution du temps de calcul, mémoire, et statut d'intégrité.
  - Système de vote aveugle ou arbitré avec calcul dynamique d'un classement ELO.
- **F3 : Scorecard Détaillée de Dépôt**
  - Fiche d'identité complète : Score IA composite (/100), décomposition (Popularité, Forks/Stars, Vélocité, Documentation), état d'activité récent (`pushedAt`), conformité licence.
- **F4 : Badges Dynamiques SVG "Harness Verified"**
  - Endpoint HTTP servant un badge SVG vectoriel temps réel (`/api/badge/:owner/:repo`) affichant le statut de test (`Exit Code: 0 | pass@k: 99.8% | ELO: 1640`) intégrable dans tout `README.md`.
- **F5 : Studio VibeCoding 1-Click**
  - Bouton permettant de générer les 8 documents d'architecture normatifs pour n'importe quel dépôt afin de lancer immédiatement un projet basé sur cette stack.

### P1 — Évolutions à Échelle
- Duels personnalisés soumis par les utilisateurs avec conteneurs WebAssembly in-browser.
- Synchronisation quotidienne automatisée avec la GitHub Search API / GH Archive.
- Export direct de listes SSH pour workers d'ingestion et clusters d'entraînement.

### Hors Périmètre (Out of Scope v1)
- Hébergement de code Git (GitArena est un moteur d'évaluation et de découverte, pas un forge Git).
- Exécution de code arbitraire non sandboxé côté serveur.

## 4. Principes d'Expérience Utilisateur (UX Principles)
- **Règle des 3 Clics** : Tout dépôt ou duel doit être accessible en moins de 3 clics depuis la page d'accueil.
- **Vitesse Wire-Speed** : Rendu des pages sous 100 ms, recherche sous 15 ms, zéro layout shift (CLS = 0).
- **Thème Cyber-Industrial** : Immersion visuelle inspirée des terminaux haute performance, palette sombre, contraste WCAG AAA.

## 5. Métriques de Succès (KPIs)
- **Taux de rétention hebdomadaire (W1)** : $\ge 35\%$.
- **Adoption des badges GitHub** : $\ge 500$ dépôts arborant le badge dans les 30 premiers jours.
- **Requêtes de recherche servies** : $> 100\text{ req/sec}$ avec un temps de réponse $< 20\text{ ms}$ sur une machine standard.
