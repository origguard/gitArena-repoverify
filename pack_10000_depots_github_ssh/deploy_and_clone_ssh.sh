#!/usr/bin/env bash
# ==============================================================================
# Script SSH clé en main : Extraction & Clonage des 10 000 Dépôts GitHub IA
# Usage sur serveur distant (SSH) :
#   export GITHUB_TOKEN="ghp_votre_token_github"
#   bash deploy_and_clone_ssh.sh [--clone] [--jobs 8]
# ==============================================================================

set -euo pipefail

LIMIT=10000
PUSHED_AFTER="2024-01-01"
MD_OUTPUT="10000_depots_github_ia.md"
SSH_LIST_OUTPUT="10000_depots_ssh_urls.txt"
CORPUS_DIR="./corpus_github_ia"
PARALLEL_JOBS=8
DO_CLONE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clone)
      DO_CLONE=true
      shift
      ;;
    --jobs)
      PARALLEL_JOBS="$2"
      shift 2
      ;;
    --limit)
      LIMIT="$2"
      shift 2
      ;;
    *)
      echo "Option inconnue : $1" >&2
      echo "Usage: bash deploy_and_clone_ssh.sh [--limit 10000] [--clone] [--jobs 8]" >&2
      exit 1
      ;;
  esac
done

echo "[1/3] Vérification de la configuration SSH GitHub..."
ssh -T -o StrictHostKeyChecking=accept-new git@github.com 2>&1 | grep -E "successfully authenticated|Hi " || {
  echo "Avertissement : Clé SSH GitHub non détectée ou agent SSH inactif (ssh-add)." >&2
}

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "Erreur : Veuillez définir votre jeton GitHub avant de lancer le script :" >&2
  echo "  export GITHUB_TOKEN='ghp_votre_token_github'" >&2
  exit 1
fi

echo "[2/3] Génération du classement Markdown (${MD_OUTPUT}) et de la liste SSH (${SSH_LIST_OUTPUT})..."
python3 generate_10k_github_repos.py \
  --limit "${LIMIT}" \
  --pushed-after "${PUSHED_AFTER}" \
  --output "${MD_OUTPUT}" \
  --ssh-list-output "${SSH_LIST_OUTPUT}"

echo "[3/3] Fichiers générés avec succès :"
echo "  - Livrable Markdown client : ${MD_OUTPUT}"
echo "  - Liste d'URI SSH (clonage): ${SSH_LIST_OUTPUT}"

if [[ "${DO_CLONE}" == true ]]; then
  echo "[Clonage SSH] Démarrage du clonage superficiel (--depth 1) avec ${PARALLEL_JOBS} workers parallèles dans ${CORPUS_DIR}..."
  mkdir -p "${CORPUS_DIR}"
  cd "${CORPUS_DIR}"
  xargs -P "${PARALLEL_JOBS}" -n 1 git clone --depth 1 --single-branch < "../${SSH_LIST_OUTPUT}"
  echo "[Terminé] Clonage SSH du corpus IA achevé dans ${CORPUS_DIR}."
else
  echo "Astuce : Ajoutez l'option --clone pour cloner automatiquement les 10 000 dépôts via SSH."
fi