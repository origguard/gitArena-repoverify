/**
 * Drapeaux de gouvernance fail-closed — RepoVerify / GitArena (Runbook §3 & §6)
 * Tout verdict public ou outil d'émission reste DÉSACTIVÉ par défaut
 * tant que les conditions de vérification et de custody ne sont pas réunies.
 */

export function isVerdictsSurfaceExposed() {
  return process.env.REPOVERIFY_EXPOSE_VERDICTS === 'true';
}

export const EXPOSE_VERDICTS = isVerdictsSurfaceExposed();

export function getScannerRepoId() {
  const raw = Number(process.env.REPOVERIFY_SCANNER_REPO_ID ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}
