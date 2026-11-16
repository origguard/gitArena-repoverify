/**
 * Moteur de Calcul du Score de Potentiel IA (/100)
 * Aligné sur les spécifications de 10000_depots_github_ia.md & BigCode The Stack v2
 */

export function calculateAiScore({
  stars = 0,
  forks = 0,
  pushedAt = new Date().toISOString(),
  hasDescription = true,
  license = 'MIT',
  sizeKb = 15000
}) {
  // 1. Popularité Logarithmique (40 pts max)
  const safeStars = Math.max(0, Number(stars) || 0);
  const logStars = Math.log10(safeStars + 1);
  const maxLogStars = Math.log10(150000);
  const popularityScore = Math.min(40, (logStars / maxLogStars) * 40);

  // 2. Adoption et Réutilisabilité (25 pts max)
  const safeForks = Math.max(0, Number(forks) || 0);
  const logForks = Math.log10(safeForks + 1);
  const maxLogForks = Math.log10(30000);
  const forkVolume = Math.min(18, (logForks / maxLogForks) * 18);
  const forkRatio = safeStars > 0 ? safeForks / safeStars : 0;
  const ratioScore = Math.min(7, forkRatio * 35);
  const adoptionScore = forkVolume + ratioScore;

  // 3. Fraîcheur & Vélocité de Maintenance (20 pts max)
  const now = new Date();
  const pushDate = new Date(pushedAt);
  const diffDays = Math.max(0, (now.getTime() - pushDate.getTime()) / (1000 * 60 * 60 * 24));
  const freshnessScore = 20 * Math.exp(-diffDays / 180);

  // 4. Richesse Structurelle & Licence Permissive (15 pts max)
  let structureScore = 0;
  if (hasDescription) structureScore += 5;
  if (sizeKb >= 500 && sizeKb <= 500000) structureScore += 5;
  
  const permissive = ['mit', 'apache-2.0', 'bsd-3-clause', 'bsd-2-clause', 'isc', '0bsd', 'unlicense'];
  if (permissive.includes(String(license).toLowerCase())) {
    structureScore += 5;
  }

  const total = popularityScore + adoptionScore + freshnessScore + structureScore;
  return Math.round(Math.min(100, Math.max(0, total)) * 100) / 100;
}
