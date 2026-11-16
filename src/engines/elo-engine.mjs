/**
 * Moteur ELO de Tournoi Dialectique
 * Conforme au protocole Sovereign Arena (K-factor = 32)
 */

export function calculateEloUpdate(ratingA, ratingB, outcome, kFactor = 32) {
  // outcome: 1.0 = A gagne, 0.5 = Match Nul, 0.0 = B gagne (A perd)
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const expectedB = 1 / (1 + Math.pow(10, (ratingA - ratingB) / 400));

  const changeA = Math.round(kFactor * (outcome - expectedA));
  // Pour garantir la stricte conservation du total des points
  const changeB = -changeA;

  return {
    newRatingA: Math.max(100, ratingA + changeA),
    newRatingB: Math.max(100, ratingB + changeB),
    deltaA: changeA,
    deltaB: changeB,
    expectedA: Math.round(expectedA * 1000) / 1000,
    expectedB: Math.round(expectedB * 1000) / 1000
  };
}
