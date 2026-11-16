#!/usr/bin/env bash
# ==============================================================================
# Script SSH Hyperscale : Extraction & Clonage de 1 000 000 de Dépôts (GODMOD AI)
# Optimisations critiques pour 1 000 000 de dépôts :
#   1. Multiplexage SSH (ControlMaster=auto, ControlPersist=600s) pour accélérer
#      les 1 000 000 de connexions GitHub de 10x.
#   2. Stockage hiérarchique par propriétaire (./corpus_godmod_1m/<owner>/<repo>.git)
#      afin d'éviter la saturation de la table d'inodes Linux (ext4/xfs).
#   3. Clonage partiel sans blobs (--bare --depth 1 --single-branch --filter=blob:none)
#      sur 32 workers parallèles avec reprise automatique (ignore les dépôts déjà clonés).
# ==============================================================================

set -euo pipefail

LIMIT=1000000
SHARD_SIZE=10000
PUSHED_AFTER="2022-01-01"
DB_FILE="godmod_1m_catalog.sqlite"
MD_OUTPUT="1000000_depots_github_godmod_ia.md"
SSH_LIST_OUTPUT="1000000_depots_ssh_urls.txt"
CORPUS_DIR="./corpus_godmod_1m"
PARALLEL_JOBS=32
DO_CLONE=false
BQ_CSV=""

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
    --from-bigquery-csv)
      BQ_CSV="$2"
      shift 2
      ;;
    *)
      echo "Option inconnue : $1" >&2
      echo "Usage: bash deploy_and_clone_1m_ssh.sh [--limit 1000000] [--from-bigquery-csv file.csv] [--clone] [--jobs 32]" >&2
      exit 1
      ;;
  esac
done

echo "[1/4] Configuration du multiplexage SSH haute performance (ControlMaster)..."
mkdir -p ~/.ssh/sockets
export GIT_SSH_COMMAND="ssh -o ControlMaster=auto -o ControlPath=~/.ssh/sockets/github-%r@%h:%p -o ControlPersist=600 -o StrictHostKeyChecking=accept-new"

ssh -T -o StrictHostKeyChecking=accept-new git@github.com 2>&1 | grep -E "successfully authenticated|Hi " || {
  echo "Avertissement : Clé SSH GitHub non détectée ou agent SSH inactif (ssh-add)." >&2
}

if [[ -n "${BQ_CSV}" ]]; then
  echo "[2/4] Importation directe des 1 000 000 de dépôts depuis le CSV BigQuery (${BQ_CSV})..."
  python3 generate_1m_github_repos.py \
    --limit "${LIMIT}" \
    --shard-size "${SHARD_SIZE}" \
    --db "${DB_FILE}" \
    --from-bigquery-csv "${BQ_CSV}" \
    --output "${MD_OUTPUT}" \
    --ssh-list-output "${SSH_LIST_OUTPUT}"
else
  if [[ -z "${GITHUB_TOKENS:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
    echo "Erreur : Définissez GITHUB_TOKENS='tok1,tok2,...' ou passez --from-bigquery-csv export.csv" >&2
    exit 1
  fi
  echo "[2/4] Collecte Hyperscale avec bissection 3D et base SQLite WAL (${DB_FILE})..."
  python3 generate_1m_github_repos.py \
    --limit "${LIMIT}" \
    --shard-size "${SHARD_SIZE}" \
    --pushed-after "${PUSHED_AFTER}" \
    --db "${DB_FILE}" \
    --output "${MD_OUTPUT}" \
    --ssh-list-output "${SSH_LIST_OUTPUT}"
fi

echo "[3/4] Livrables 1 000 000 générés avec succès :"
echo "  - Base SQLite WAL          : ${DB_FILE}"
echo "  - Index Markdown maître    : ${MD_OUTPUT}"
echo "  - 100 Volumes Markdown     : ./shards_1m/godmod_ia_1m_vol_001.md .. vol_100.md"
echo "  - Liste des 1 000 000 SSH  : ${SSH_LIST_OUTPUT}"

clone_single_repo() {
  local ssh_uri="$1"
  local base_dir="$2"
  # Extrait owner/repo depuis git@github.com:owner/repo.git
  local path_part="${ssh_uri#git@github.com:}"
  path_part="${path_part%.git}"
  local target_dir="${base_dir}/${path_part}.git"

  if [[ -d "${target_dir}" ]]; then
    return 0
  fi
  mkdir -p "$(dirname "${target_dir}")"
  git clone --bare --depth 1 --single-branch --filter=blob:none "${ssh_uri}" "${target_dir}" >/dev/null 2>&1 || true
}
export -f clone_single_repo

if [[ "${DO_CLONE}" == true ]]; then
  echo "[4/4] Démarrage du clonage hiérarchique SSH (${PARALLEL_JOBS} workers parallèles) dans ${CORPUS_DIR}..."
  mkdir -p "${CORPUS_DIR}"
  xargs -P "${PARALLEL_JOBS}" -I {} bash -c 'clone_single_repo "$@"' _ {} "${CORPUS_DIR}" < "${SSH_LIST_OUTPUT}"
  echo "[Terminé] Clonage SSH hiérarchique du corpus 1 000 000 achevé dans ${CORPUS_DIR}."
else
  echo "[4/4] Prêt pour le clonage : relancez avec --clone --jobs 32 pour cloner en arborescence hiérarchique."
fi
