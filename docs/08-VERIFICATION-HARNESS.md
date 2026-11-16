# 08-VERIFICATION-HARNESS : Harnais de Validation E2E & Forcing Function — GitArena

## 1. Principes Fondateurs (Doctrine OrigGuard & Harness Engineering)
- **Règle 1 (Code de Sortie 0 Impératif)** : Aucun jalon n'est validé tant que le banc d'épreuve automatisé `node tests/test-gitarena-e2e.mjs` n'a pas retourné le code de succès exact `process.exit(0)`.
- **Règle 2 (Zéro Simulation / Zéro Mock)** : Tous les tests s'exécutent contre la base SQLite réelle et le serveur HTTP réel, avec de vraies requêtes de recherche FTS5 et des calculs réels de scores ELO.
- **Règle 3 (Scanner Anti-TODO)** : Le harnais vérifie automatiquement qu'aucun fichier source ne contient de chaînes interdites : `// TODO`, `// FIXME`, `mockData`, `fakeScore`, `sandbox-demo`.

---

## 2. Matrice d'Assertions E2E

| ID Assertion | Périmètre Testé | Condition de Succès | Critère d'Échec |
| :--- | :--- | :--- | :--- |
| `TEST-01` | **Schéma & Persistance SQLite WAL** | Initialisation sans erreur, tables `repositories`, `repositories_fts`, `arena_duels` créées et mode WAL actif. | Échec création table ou mode `DELETE`/`OFF`. |
| `TEST-02` | **Ingestion & Seeding Réel** | Au moins 200 dépôts critiques insérés avec scores IA $> 0$ et licences valides. | Nombre de dépôts $< 200$ ou score IA nul. |
| `TEST-03` | **Recherche Plein-Texte FTS5** | Requête `transformers` retourne `huggingface/transformers` en $< 15\text{ ms}$. | Résultat vide ou temps d'exécution $> 50\text{ ms}$. |
| `TEST-04` | **Moteur ELO Mathématique** | Victoire de A contre B : $\text{ELO}_A \uparrow$, $\text{ELO}_B \downarrow$ et $\Delta_A + \Delta_B = 0$. | Déséquilibre de la somme des points ou score négatif. |
| `TEST-05` | **API REST Endpoints** | Requêtes HTTP réelles sur `GET /api/repos`, `GET /api/arena/duel`, `POST /api/arena/vote` retournant `200 OK`. | Code HTTP différent de `200` ou schéma JSON non conforme. |
| `TEST-06` | **Génération de Badge SVG** | Requête sur `/api/badge/huggingface/transformers` retourne un flux SVG valide (`<svg ...>`). | Entête non-SVG ou balise SVG absente. |
| `TEST-07` | **Générateur VibeCoding 8-Docs** | Requête sur `/api/scaffold/...` retourne les 8 noms de documents d'architecture normatifs. | Moins de 8 documents référencés. |
| `TEST-08` | **Scanner Anti-Simulation** | Aucun fichier de production ne contient de marqueurs `TODO`, `FIXME` ou `mock`. | Détection d'un marqueur proscrit. |

---

## 3. Commande d'Exécution du Banc d'Épreuve
```bash
node tests/test-gitarena-e2e.mjs
```
La sortie doit obligatoirement se conclure par :
```
[HARNESS] 8/8 assertions vérifiées avec succès.
[HARNESS] Intégrité scellée. Code de sortie : 0.
```
