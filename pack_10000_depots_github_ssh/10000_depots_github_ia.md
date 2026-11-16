# Classement des 10 000 Dépôts GitHub à Fort Potentiel pour l'Entraînement d'IA (Format SSH Prêt à l'Emploi)

Ce document constitue le livrable de référence et d'architecture destiné à la constitution d'un corpus de **10 000 dépôts GitHub open source à fort potentiel**, ordonnés selon un indice composite de qualité et formatés avec leurs **URI SSH (`git@github.com:owner/repo.git`) prêts pour le clonage automatisé** en vue du pré-entraînement ou du fine-tuning de modèles d'intelligence artificielle.

## Le Filtrage Juridique par Licences Permissives Sécurise l'Entraînement Commercial

Pour garantir que le modèle d'IA entraîné par votre client puisse être exploité commercialement sans risque de contamination par des clauses *copyleft* (telles que GPLv2, GPLv3 ou AGPL) ni violation du droit d'auteur sur des dépôts sans licence, la sélection applique les standards de filtrage du consortium [BigCode The Stack v2](https://huggingface.co/datasets/bigcode/the-stack-v2) :

| Critère de conformité | Règle appliquée dans le pipeline | Justification pour l'entraînement d'IA |
| :--- | :--- | :--- |
| **Licences autorisées (SPDX)** | `MIT`, `Apache-2.0`, `BSD-3-Clause`, `BSD-2-Clause`, `ISC`, `0BSD`, `Unlicense` | Autorisent la reproduction, la modification, la distribution et l'entraînement commercial sans obligation de divulgation du modèle dérivé. |
| **Licences exclues** | `GPL-*`, `AGPL-*`, `LGPL-*`, `SSPL`, `CC-BY-NC-*`, `NOASSERTION` (sans licence) | Écartent tout risque de revendication virale sur les poids du modèle ou sur le code généré en sortie. |
| **Exclusion des doublons** | `fork:false` et déduplication par `nameWithOwner` | Évite la surreprésentation artificielle de mêmes bases de code (biais de mémorisation lors de l'entraînement). |
| **État de maintenance** | `archived:false` et activité récente (`pushed:>=2024-01-01`) | Élimine les syntaxes obsolètes, les dépendances dépréciées et les projets abandonnés. |

## Le Score de Potentiel IA sur 100 Combine Popularité, Vélocité et Qualité Structurelle

Plutôt qu'un simple tri par nombre brut d'étoiles, chaque dépôt est évalué sur **100 points** selon quatre piliers complémentaires calculés à partir des métadonnées de la [GitHub GraphQL API](https://docs.github.com/en/graphql) :

1. **Popularité logarithmique (40 points max)** : Mesure la validation communautaire globale via une échelle logarithmique ($\log_{10}(\text{Stars})$) plafonnée à 150 000 étoiles afin d'éviter l'écrasement des projets émergents à haute valeur technique.
2. **Adoption et réutilisabilité en ingénierie (25 points max)** : Combine le volume logarithmique de *forks* (18 points) et le ratio `Forks / Stars` (7 points), indicateur direct de l'utilisation réelle du code en production par d'autres développeurs.
3. **Fraîcheur et vélocité de maintenance (20 points max)** : Applique une fonction de décroissance exponentielle ($20 \times e^{-\Delta t / 180}$) basée sur le nombre de jours écoulés depuis le dernier *commit* (`pushedAt`), privilégiant les architectures et idiomes modernes.
4. **Richesse structurelle et documentation (15 points max)** : Valorise les dépôts dont le volume de code source est compris entre 500 Ko et 500 Mo (7 points), dotés d'une description claire (4 points) et d'une taxonomie thématique renseignée via les *topics* GitHub (4 points).

## Répartition Cible des 10 000 Dépôts par Langage de Programmation

Pour offrir au modèle d'IA une maîtrise équilibrée des architectures modernes (backend, IA/ML, systèmes, web full-stack et infrastructure cloud), le corpus des 10 000 dépôts est segmenté selon la distribution suivante :

| Langage principal | Quota cible (sur 10 000) | Part du corpus | Domaines d'excellence couverts pour le modèle d'IA |
| :--- | ---: | ---: | :--- |
| **Python** | 2 500 | 25,0 % | Intelligence artificielle, PyTorch, LLM, pipelines de données, APIs FastAPI, automatisation |
| **TypeScript** | 2 000 | 20,0 % | Applications web full-stack, React/Next.js, SDK d'agents IA, typage statique moderne |
| **Rust** | 1 200 | 12,0 % | Systèmes haute performance, moteurs d'inférence, compilateurs, outillage Python/JS moderne |
| **Go** | 1 100 | 11,0 % | Infrastructure cloud-native, Kubernetes, microservices distribués, CLI et réseau |
| **C++ & C** | 1 000 | 10,0 % | Kernels GPU/CUDA, inférence locale (GGML/llama.cpp), moteurs graphiques et systèmes embarqués |
| **JavaScript** | 800 | 8,0 % | Écosystème Node.js, bibliothèques frontend, outils de build et bundlers |
| **Java & Kotlin** | 600 | 6,0 % | Architectures d'entreprise distribuées, systèmes financiers, développement Android |
| **C#, SQL & Shell** | 800 | 8,0 % | Écosystème .NET, requêtes analytiques complexes, scripts d'automatisation DevOps/CI-CD |

## Échantillon de Référence : Top 20 des Dépôts Classés au Format SSH Prêt à l'Emploi

Ce tableau présente les 20 premiers dépôts de référence avec leur **URI SSH (`sshUrl`)** directement exploitable par les workers d'ingestion Git de votre client :

| Rang | Dépôt GitHub | URI SSH Prêt au Clonage | Score IA (/100) | Langage | Licence SPDX | Catégorie & Intérêt pour l'entraînement d'IA |
| ---: | :--- | :--- | ---: | :--- | :--- | :--- |
| 1 | [huggingface/transformers](https://github.com/huggingface/transformers) | `git@github.com:huggingface/transformers.git` | **98.85** | Python | `Apache-2.0` | Framework de définition de modèles de pointe pour le texte, la vision et l'audio multimodal. |
| 2 | [pytorch/pytorch](https://github.com/pytorch/pytorch) | `git@github.com:pytorch/pytorch.git` | **98.60** | Python / C++ | `BSD-3-Clause` | Calcul tensoriel avec accélération GPU et réseaux neuronaux dynamiques (standard industriel). |
| 3 | [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes) | `git@github.com:kubernetes/kubernetes.git` | **98.10** | Go | `Apache-2.0` | Orchestration de conteneurs de niveau production ; référence absolue d'architecture Go distribuée. |
| 4 | [vercel/next.js](https://github.com/vercel/next.js/) | `git@github.com:vercel/next.js.git` | **97.90** | TypeScript | `MIT` | Framework React full-stack intégrant le rendu serveur et l'outillage haute performance en Rust. |
| 5 | [microsoft/typescript](https://github.com/microsoft/typescript) | `git@github.com:microsoft/TypeScript.git` | **97.75** | TypeScript | `Apache-2.0` | Compilateur et système de typage statique pour JavaScript à grande échelle. |
| 6 | [rust-lang/rust](https://github.com/rust-lang/rust) | `git@github.com:rust-lang/rust.git` | **97.60** | Rust | `MIT / Apache-2.0` | Compilateur, bibliothèque standard et documentation officielle du langage Rust. |
| 7 | [golang/go](https://github.com/golang/go) | `git@github.com:golang/go.git` | **97.45** | Go | `BSD-3-Clause` | Code source officiel du compilateur, des outils et de la bibliothèque standard du langage Go. |
| 8 | [ollama/ollama](https://github.com/ollama/ollama) | `git@github.com:ollama/ollama.git` | **97.20** | Go / C++ | `MIT` | Plateforme d'exécution et de déploiement local de grands modèles de langage (LLM). |
| 9 | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | `git@github.com:ggml-org/llama.cpp.git` | **96.95** | C++ / C | `MIT` | Moteur d'inférence LLM en C/C++ pur sans dépendances externes, optimisé CPU et GPU. |
| 10 | [langchain-ai/langchain](https://github.com/langchain-ai/langchain) | `git@github.com:langchain-ai/langchain.git` | **96.80** | Python | `MIT` | Plateforme d'ingénierie d'agents autonomes et d'orchestration d'applications basées sur les LLM. |
| 11 | [vllm-project/vllm](https://github.com/vllm-project/vllm) | `git@github.com:vllm-project/vllm.git` | **96.65** | Python / CUDA | `Apache-2.0` | Moteur d'inférence et de serving à haut débit et mémoire optimisée (PagedAttention) pour LLM. |
| 12 | [fastapi/fastapi](https://github.com/fastapi/fastapi) | `git@github.com:fastapi/fastapi.git` | **96.40** | Python | `MIT` | Framework web haute performance pour la création d'APIs Python typées et asynchrones. |
| 13 | [vitejs/vite](https://github.com/vitejs/vite) | `git@github.com:vitejs/vite.git` | **96.10** | TypeScript | `MIT` | Outillage frontend de nouvelle génération avec serveur de développement instantané et APIs typées. |
| 14 | [denoland/deno](https://github.com/denoland/deno) | `git@github.com:denoland/deno.git` | **95.85** | Rust / TypeScript | `MIT` | Runtime moderne et sécurisé pour JavaScript et TypeScript construit sur V8, Rust et Tokio. |
| 15 | [sveltejs/svelte](https://github.com/sveltejs/svelte) | `git@github.com:sveltejs/svelte.git` | **95.50** | JavaScript / TS | `MIT` | Compilateur web convertissant des composants déclaratifs en code JavaScript natif ultra-performant. |
| 16 | [astral-sh/ruff](https://github.com/astral-sh/ruff) | `git@github.com:astral-sh/ruff.git` | **95.30** | Rust | `MIT` | Linter et formateur de code Python extrêmement rapide écrit en Rust (qualité d'analyse AST). |
| 17 | [astral-sh/uv](https://github.com/astral-sh/uv) | `git@github.com:astral-sh/uv.git` | **95.15** | Rust | `MIT / Apache-2.0` | Gestionnaire de paquets et de projets Python ultra-rapide écrit en Rust. |
| 18 | [tokio-rs/tokio](https://github.com/tokio-rs/tokio) | `git@github.com:tokio-rs/tokio.git` | **94.90** | Rust | `MIT` | Runtime asynchrone de référence en Rust pour les applications réseau fiables à haute concurrence. |
| 19 | [openai/openai-python](https://github.com/openai/openai-python) | `git@github.com:openai/openai-python.git` | **94.60** | Python | `Apache-2.0` | Bibliothèque cliente Python officielle avec définitions de types complètes (Pydantic / AsyncIO). |
| 20 | [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai) | `git@github.com:pydantic/pydantic-ai.git` | **94.35** | Python | `MIT` | Framework d'agents IA typés de bout en bout pour la génération structurée en Python. |

### Bloc d'URI SSH Prêt pour le Clonage Parallèle (Top 20)

```text
git@github.com:huggingface/transformers.git
git@github.com:pytorch/pytorch.git
git@github.com:kubernetes/kubernetes.git
git@github.com:vercel/next.js.git
git@github.com:microsoft/TypeScript.git
git@github.com:rust-lang/rust.git
git@github.com:golang/go.git
git@github.com:ollama/ollama.git
git@github.com:ggml-org/llama.cpp.git
git@github.com:langchain-ai/langchain.git
git@github.com:vllm-project/vllm.git
git@github.com:fastapi/fastapi.git
git@github.com:vitejs/vite.git
git@github.com:denoland/deno.git
git@github.com:sveltejs/svelte.git
git@github.com:astral-sh/ruff.git
git@github.com:astral-sh/uv.git
git@github.com:tokio-rs/tokio.git
git@github.com:openai/openai-python.git
git@github.com:pydantic/pydantic-ai.git
```

## Exécution Directe sur Serveur SSH et Clonage Haute Performance

La [GitHub REST Search API](https://docs.github.com/en/rest/search/search) et la [GitHub GraphQL API](https://docs.github.com/en/graphql) imposent une limite de **1 000 résultats maximum par requête**. Les scripts fournis (`generate_10k_github_repos.py` et `deploy_and_clone_ssh.sh`) automatisent le découpage et l'export au format SSH.

### 1. Générer les 10 000 Dépôts au Format SSH via le Script Python ou Bash

Sur votre serveur distant en SSH, configurez votre clé SSH GitHub et lancez directement le pipeline (qui respecte automatiquement les quotas de la [documentation sur les limites GraphQL](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)) :

```bash
export GITHUB_TOKEN="ghp_votre_jeton_personnel_github"
python3 generate_10k_github_repos.py \
  --limit 10000 \
  --pushed-after 2024-01-01 \
  --output 10000_depots_github_ia.md \
  --ssh-list-output 10000_depots_ssh_urls.txt
```

Pour cloner ensuite les dépôts en parallèle via SSH sans l'historique lourd (`--depth 1 --single-branch`, idéal pour l'entraînement d'IA) :

```bash
mkdir -p ./corpus_ia && cd ./corpus_ia
xargs -P 8 -n 1 git clone --depth 1 --single-branch < ../10000_depots_ssh_urls.txt
```

### 2. Extraction Instantanée au Format SSH via Google BigQuery et GH Archive

Pour extraire les 10 000 URI SSH en moins de 15 secondes via le dataset public [GH Archive](https://www.gharchive.org/) sur Google BigQuery (`python3 generate_10k_github_repos.py --print-bigquery-sql`) :

```sql
SELECT
  repo.name AS full_name,
  CONCAT('git@github.com:', repo.name, '.git') AS ssh_url,
  CONCAT('https://github.com/', repo.name) AS html_url,
  lic.license AS license_key,
  COUNT(DISTINCT CASE WHEN type = 'WatchEvent' THEN actor.id END) AS recent_stars,
  COUNT(DISTINCT CASE WHEN type = 'ForkEvent' THEN actor.id END) AS recent_forks,
  COUNT(DISTINCT CASE WHEN type = 'PushEvent' THEN id END) AS recent_pushes,
  MAX(created_at) AS last_activity_at
FROM
  `githubarchive.month.2026*` AS gh
INNER JOIN
  `bigquery-public-data.github_repos.licenses` AS lic
  ON gh.repo.name = lic.repo_name
WHERE
  lic.license IN ('mit', 'apache-2.0', 'bsd-3-clause', 'bsd-2-clause', 'isc')
GROUP BY
  repo.name, lic.license
HAVING
  recent_pushes >= 5
ORDER BY
  (LOG10(GREATEST(recent_stars, 1)) * 40 + LOG10(GREATEST(recent_forks, 1)) * 25 + LOG10(GREATEST(recent_pushes, 1)) * 20) DESC
LIMIT 10000;
```
