#!/usr/bin/env python3
"""
Générateur automatisé des 10 000 dépôts GitHub à fort potentiel pour l'entraînement d'IA.
Produit :
1. Un fichier Markdown (.md) classé par Score de Potentiel IA (0-100) incluant l'URI SSH prêt au clonage (git@github.com:owner/repo.git).
2. Un fichier texte (.txt) contenant uniquement les 10 000 URI SSH prêts pour un clonage parallèle via xargs/git.

Sources et références officielles :
- GitHub REST Search API : https://docs.github.com/en/rest/search/search
- GitHub GraphQL API v4  : https://docs.github.com/en/graphql
- GH Archive (BigQuery)  : https://www.gharchive.org/
- BigCode The Stack v2   : https://huggingface.co/datasets/bigcode/the-stack-v2
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple


# Licences open source permissives adaptées à l'entraînement de modèles d'IA (conformes BigCode / The Stack v2)
PERMISSIVE_LICENSES: Tuple[str, ...] = (
    "mit",
    "apache-2.0",
    "bsd-3-clause",
    "bsd-2-clause",
    "isc",
    "0bsd",
    "unlicense",
)

# Répartition par langages prioritaires pour l'entraînement de LLM de code
DEFAULT_LANGUAGES: Tuple[str, ...] = (
    "Python",
    "TypeScript",
    "Rust",
    "Go",
    "C++",
    "JavaScript",
    "Java",
    "C",
    "C#",
    "SQL",
    "Shell",
    "Kotlin",
)

# Découpage par tranches d'étoiles pour contourner la limite de 1 000 résultats par requête de l'API GitHub
STAR_RANGES: Tuple[str, ...] = (
    ">=50000",
    "20000..49999",
    "10000..19999",
    "5000..9999",
    "3000..4999",
    "2000..2999",
    "1500..1999",
    "1000..1499",
    "750..999",
    "500..749",
)

GRAPHQL_ENDPOINT = "https://api.github.com/graphql"


@dataclass
class RepoRecord:
    full_name: str
    url: str
    ssh_url: str
    description: str
    language: str
    license_spdx: str
    stars: int
    forks: int
    open_issues: int
    size_kb: int
    pushed_at: str
    created_at: str
    topics: List[str]
    ai_potential_score: float = 0.0


def compute_ai_potential_score(
    stars: int,
    forks: int,
    pushed_at_iso: str,
    size_kb: int,
    has_description: bool,
    topics_count: int,
    reference_date: Optional[dt.datetime] = None,
) -> float:
    """
    Calcule un Score de Potentiel IA sur 100 combinant 4 piliers :
    1. Popularité logarithmique (Stars)                  : max 40 pts
    2. Adoption et réutilisabilité (Forks & ratio)       : max 25 pts
    3. Fraîcheur et maintenance active (Dernier push)    : max 20 pts
    4. Qualité structurelle et documentation (Taille/Méta): max 15 pts
    """
    if reference_date is None:
        reference_date = dt.datetime.now(dt.timezone.utc)

    star_score = min(40.0, (math.log10(max(stars, 1)) / math.log10(150000)) * 40.0)

    fork_abs_score = min(18.0, (math.log10(max(forks, 1)) / math.log10(40000)) * 18.0)
    fork_ratio = min(1.0, (forks / max(stars, 1)) / 0.25)
    fork_score = fork_abs_score + (fork_ratio * 7.0)

    try:
        clean_iso = pushed_at_iso.replace("Z", "+00:00")
        pushed_dt = dt.datetime.fromisoformat(clean_iso)
        days_since_push = max(0.0, (reference_date - pushed_dt).total_seconds() / 86400.0)
    except Exception:
        days_since_push = 365.0
    freshness_score = 20.0 * math.exp(-days_since_push / 180.0)

    if 500 <= size_kb <= 500_000:
        size_score = 7.0
    elif 100 <= size_kb < 500:
        size_score = 4.0
    else:
        size_score = 2.0

    meta_score = (4.0 if has_description else 0.0) + min(4.0, topics_count * 1.0)
    quality_score = size_score + meta_score

    total = star_score + fork_score + freshness_score + quality_score
    return round(min(100.0, max(0.0, total)), 2)


GRAPHQL_SEARCH_QUERY = """
query SearchHighPotentialRepos($queryString: String!, $cursor: String) {
  search(query: $queryString, type: REPOSITORY, first: 100, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on Repository {
        nameWithOwner
        url
        sshUrl
        description
        stargazerCount
        forkCount
        diskUsage
        pushedAt
        createdAt
        issues(states: OPEN) {
          totalCount
        }
        primaryLanguage {
          name
        }
        licenseInfo {
          spdxId
          key
        }
        repositoryTopics(first: 6) {
          nodes {
            topic {
              name
            }
          }
        }
      }
    }
  }
  rateLimit {
    remaining
    resetAt
  }
}
"""


def github_graphql_request(
    token: str, query_string: str, cursor: Optional[str] = None
) -> Dict:
    payload = json.dumps(
        {
            "query": GRAPHQL_SEARCH_QUERY,
            "variables": {"queryString": query_string, "cursor": cursor},
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        GRAPHQL_ENDPOINT,
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "AI-Training-Repo-Curator-SSH/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_slice_graphql(
    token: str,
    query_string: str,
    repos_by_name: Dict[str, RepoRecord],
    target_count: int,
) -> None:
    cursor: Optional[str] = None
    pages_fetched = 0

    while pages_fetched < 10 and len(repos_by_name) < target_count:
        try:
            data = github_graphql_request(token, query_string, cursor)
        except urllib.error.HTTPError as err:
            if err.code in (403, 429):
                print(
                    f"[Rate Limit] Pause de 60s suite au code HTTP {err.code}...",
                    file=sys.stderr,
                )
                time.sleep(60)
                continue
            raise

        if "errors" in data:
            print(f"[Avertissement GraphQL] {data['errors']}", file=sys.stderr)
            break

        search_block = data.get("data", {}).get("search", {})
        nodes = search_block.get("nodes", [])
        if not nodes:
            break

        for node in nodes:
            if not node or "nameWithOwner" not in node:
                continue
            full_name = node["nameWithOwner"]
            if full_name in repos_by_name:
                continue

            license_info = node.get("licenseInfo") or {}
            spdx = license_info.get("spdxId") or license_info.get("key") or "UNKNOWN"
            lang_info = node.get("primaryLanguage") or {}
            language = lang_info.get("name") or "Multiple"
            description = (node.get("description") or "").replace("\n", " ").strip()
            topics_nodes = (node.get("repositoryTopics") or {}).get("nodes") or []
            topics = [
                t["topic"]["name"]
                for t in topics_nodes
                if t and t.get("topic") and t["topic"].get("name")
            ]

            stars = int(node.get("stargazerCount") or 0)
            forks = int(node.get("forkCount") or 0)
            size_kb = int(node.get("diskUsage") or 0)
            pushed_at = node.get("pushedAt") or ""
            created_at = node.get("createdAt") or ""
            open_issues = int((node.get("issues") or {}).get("totalCount") or 0)
            ssh_url = node.get("sshUrl") or f"git@github.com:{full_name}.git"

            score = compute_ai_potential_score(
                stars=stars,
                forks=forks,
                pushed_at_iso=pushed_at,
                size_kb=size_kb,
                has_description=bool(description),
                topics_count=len(topics),
            )

            repos_by_name[full_name] = RepoRecord(
                full_name=full_name,
                url=node.get("url") or f"https://github.com/{full_name}",
                ssh_url=ssh_url,
                description=description,
                language=language,
                license_spdx=spdx,
                stars=stars,
                forks=forks,
                open_issues=open_issues,
                size_kb=size_kb,
                pushed_at=pushed_at[:10] if pushed_at else "N/A",
                created_at=created_at[:10] if created_at else "N/A",
                topics=topics,
                ai_potential_score=score,
            )

            if len(repos_by_name) >= target_count:
                break

        pages_fetched += 1
        page_info = search_block.get("pageInfo") or {}
        if not page_info.get("hasNextPage"):
            break
        cursor = page_info.get("endCursor")
        time.sleep(0.4)


def collect_10k_repositories(
    token: str,
    target_count: int = 10000,
    languages: Tuple[str, ...] = DEFAULT_LANGUAGES,
    licenses: Tuple[str, ...] = PERMISSIVE_LICENSES,
    pushed_after: str = "2024-01-01",
) -> List[RepoRecord]:
    """
    Parcourt les tranches d'étoiles et de langages pour extraire jusqu'à `target_count`
    dépôts uniques, non-forks, non-archivés et sous licence permissive.
    """
    repos_by_name: Dict[str, RepoRecord] = {}
    license_filter = " ".join(f"license:{lic}" for lic in licenses)

    for star_range in STAR_RANGES:
        for lang in languages:
            if len(repos_by_name) >= target_count:
                break
            query = (
                f"stars:{star_range} language:{lang} {license_filter} "
                f"fork:false archived:false pushed:>={pushed_after} sort:stars-desc"
            )
            print(
                f"[Collecte] {len(repos_by_name)}/{target_count} dépôts | Requête : {lang} ({star_range})",
                file=sys.stderr,
            )
            fetch_slice_graphql(token, query, repos_by_name, target_count)
        if len(repos_by_name) >= target_count:
            break

    ranked = sorted(
        repos_by_name.values(),
        key=lambda r: (r.ai_potential_score, r.stars, r.forks),
        reverse=True,
    )
    return ranked[:target_count]


def format_markdown_report(
    repos: List[RepoRecord],
    output_path: str,
    ssh_list_path: Optional[str] = None,
) -> None:
    """
    Écrit le fichier Markdown (.md) final classé par ordre de potentiel IA avec URI SSH
    et génère optionnellement la liste brute des URI SSH pour clonage automatisé.
    """
    now_str = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    total = len(repos)

    lang_counts: Dict[str, int] = {}
    lic_counts: Dict[str, int] = {}
    for r in repos:
        lang_counts[r.language] = lang_counts.get(r.language, 0) + 1
        lic_counts[r.license_spdx] = lic_counts.get(r.license_spdx, 0) + 1

    top_langs = sorted(lang_counts.items(), key=lambda x: x[1], reverse=True)[:10]
    top_lics = sorted(lic_counts.items(), key=lambda x: x[1], reverse=True)

    lines: List[str] = [
        "# Classement des 10 000 Dépôts GitHub à Fort Potentiel pour l'Entraînement d'IA (Format SSH)",
        "",
        f"Ce corpus recense **{total:,} dépôts GitHub open source** sélectionnés, vérifiés et classés par **Score de Potentiel IA (sur 100)** en date du `{now_str}`, avec leur **URI SSH (`git@github.com:owner/repo.git`)** prêt pour le clonage en lot.",
        "",
        "## Répartition Globale par Langage et Licence Permissive",
        "",
        "| Catégorie | Valeur | Nombre de dépôts | Part du corpus |",
        "| :--- | :--- | ---: | ---: |",
    ]

    for lang, cnt in top_langs:
        pct = (cnt / max(total, 1)) * 100.0
        lines.append(f"| Langage principal | **{lang}** | {cnt:,} | {pct:.1f}% |")

    for lic, cnt in top_lics:
        pct = (cnt / max(total, 1)) * 100.0
        lines.append(f"| Licence SPDX | `{lic}` | {cnt:,} | {pct:.1f}% |")

    lines.extend(
        [
            "",
            "## Classement Complet des Dépôts par Score de Potentiel IA (URI SSH Inclus)",
            "",
            "| Rang | Dépôt GitHub | URI SSH Prêt au Clonage | Score IA (/100) | Étoiles | Forks | Langage | Licence | Dernier Push | Description |",
            "| ---: | :--- | :--- | ---: | ---: | ---: | :--- | :--- | :--- | :--- |",
        ]
    )

    for idx, r in enumerate(repos, start=1):
        safe_desc = r.description.replace("|", "\\|")
        if len(safe_desc) > 120:
            safe_desc = safe_desc[:117] + "..."
        lines.append(
            f"| {idx} | [{r.full_name}]({r.url}) | `{r.ssh_url}` | **{r.ai_potential_score:.2f}** | "
            f"{r.stars:,} | {r.forks:,} | {r.language} | `{r.license_spdx}` | "
            f"{r.pushed_at} | {safe_desc} |"
        )

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    if ssh_list_path:
        with open(ssh_list_path, "w", encoding="utf-8") as f_ssh:
            for r in repos:
                f_ssh.write(f"{r.ssh_url}\n")


BIGQUERY_SQL_QUERY = """-- Requête BigQuery (GH Archive & bigquery-public-data.github_repos) - Format SSH
-- Permet d'extraire 10 000 dépôts permissifs avec URI SSH en moins de 15 secondes
-- Documentation : https://www.gharchive.org/
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
"""


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Génère un fichier Markdown (.md) et une liste d'URI SSH des 10 000 dépôts GitHub à fort potentiel pour entraîner une IA."
    )
    parser.add_argument(
        "--output",
        default="10000_depots_github_ia.md",
        help="Chemin du fichier Markdown de sortie (défaut: 10000_depots_github_ia.md)",
    )
    parser.add_argument(
        "--ssh-list-output",
        default="10000_depots_ssh_urls.txt",
        help="Chemin du fichier texte contenant uniquement les 10 000 URI SSH git@github.com:owner/repo.git (défaut: 10000_depots_ssh_urls.txt)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10000,
        help="Nombre total de dépôts à extraire et classer (défaut: 10000)",
    )
    parser.add_argument(
        "--pushed-after",
        default="2024-01-01",
        help="Date minimale du dernier push au format YYYY-MM-DD (défaut: 2024-01-01)",
    )
    parser.add_argument(
        "--print-bigquery-sql",
        action="store_true",
        help="Affiche la requête SQL BigQuery (GH Archive) générant les 10 000 URI SSH instantanément.",
    )
    args = parser.parse_args()

    if args.print_bigquery_sql:
        print(BIGQUERY_SQL_QUERY)
        return 0

    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token:
        print(
            "Erreur : La variable d'environnement GITHUB_TOKEN est requise pour interroger l'API GitHub GraphQL.\n"
            "Exemple d'exécution :\n"
            "  export GITHUB_TOKEN='ghp_votre_token_github'\n"
            "  python3 generate_10k_github_repos.py --limit 10000 --output 10000_depots_github_ia.md --ssh-list-output 10000_depots_ssh_urls.txt\n\n"
            "Astuce : Utilisez --print-bigquery-sql pour afficher la requête SQL BigQuery (GH Archive).",
            file=sys.stderr,
        )
        return 1

    repos = collect_10k_repositories(
        token=token,
        target_count=args.limit,
        pushed_after=args.pushed_after,
    )
    format_markdown_report(repos, args.output, args.ssh_list_output)
    print(
        f"Succès : {len(repos)} dépôts exportés dans {args.output} et URI SSH écrits dans {args.ssh_list_output}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())