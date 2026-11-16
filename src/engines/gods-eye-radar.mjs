import { createHash } from 'node:crypto';

/**
 * Sovereign God's Eye — Radar Tactique & Télémétrie Spatiale d'Écosystème
 * Clean-Room inspiré de bilawalsidhu/gods-eye-view
 * Projette les dépôts open-source en coordonnées tactiques avec télémétrie temps réel.
 */

const CATEGORY_ANGLES = {
  "Frameworks d'Orchestration & Multi-Agents": { angleBase: 0, color: '#00f3ff', tag: 'MULTI-AGENTS' },
  "Agents de Codage & Génie Logiciel (SWE)": { angleBase: 36, color: '#00ff88', tag: 'SWE-CODING' },
  "Navigation Web & Automatisation IHM": { angleBase: 72, color: '#ffaa00', tag: 'WEB-AUTOMATION' },
  "Mémoire Étendue & RAG Avancé": { angleBase: 108, color: '#ff3366', tag: 'RAG-MEMORY' },
  "Outils de LLM, Serving & Inférence Local": { angleBase: 144, color: '#bd00ff', tag: 'LLM-SERVING' },
  "Compétences Élargies, Tooling & APIs": { angleBase: 180, color: '#38bdf8', tag: 'TOOLING-APIS' },
  "Modèles de Vision-Langage & Agents Multimodaux": { angleBase: 216, color: '#f43f5e', tag: 'MULTIMODAL' },
  "Datasets d'Entraînement & Alignement d'Agents": { angleBase: 252, color: '#10b981', tag: 'DATASETS' },
  "Évaluation, Guardrails & Alignement de Sécurité": { angleBase: 288, color: '#eab308', tag: 'SECURITY' },
  "Environnements de Simulation & Benchmark Réels": { angleBase: 324, color: '#a855f7', tag: 'SIMULATION' },
  "Général": { angleBase: 340, color: '#64748b', tag: 'GENERAL' },
  "Fondations & Systèmes": { angleBase: 18, color: '#3b82f6', tag: 'CORE-SYSTEMS' }
};

export function generateRadarTelemetry(repositories = []) {
  const nodes = [];
  const layerCounts = {};

  for (let i = 0; i < repositories.length; i++) {
    const repo = repositories[i];
    const catConfig = CATEGORY_ANGLES[repo.category] || CATEGORY_ANGLES['Général'];

    // Calcul de l'angle theta avec dispersion légère pour éviter les collisions
    const angleSpread = ((i * 13) % 28) - 14;
    const angleDeg = (catConfig.angleBase + angleSpread + 360) % 360;
    const angleRad = (angleDeg * Math.PI) / 180;

    // Rayon normalisé : les projets à très haut ELO / Stars sont au centre du radar (haute priorité)
    const elo = repo.elo_rating || 1500;
    const normalizedRadius = Math.max(0.15, Math.min(0.92, 1 - ((elo - 1200) / 750)));

    const x = Math.round(Math.cos(angleRad) * normalizedRadius * 1000) / 1000;
    const y = Math.round(Math.sin(angleRad) * normalizedRadius * 1000) / 1000;

    layerCounts[catConfig.tag] = (layerCounts[catConfig.tag] || 0) + 1;

    nodes.push({
      id: repo.id,
      fullName: repo.full_name,
      name: repo.name,
      owner: repo.owner,
      stars: repo.stars,
      elo: repo.elo_rating,
      aiScore: repo.ai_potential_score,
      category: repo.category,
      layer: catConfig.tag,
      color: catConfig.color,
      coords: { x, y, angleDeg, radius: normalizedRadius },
      status: repo.ai_potential_score >= 85 ? 'ELITE_TARGET' : 'ACTIVE_TARGET'
    });
  }

  // Horodatage et empreinte SHA-256 de surveillance
  const timestamp = new Date().toISOString();
  const rawPayload = `${timestamp}|${nodes.length}|${JSON.stringify(layerCounts)}`;
  const integritySeal = createHash('sha256').update(rawPayload).digest('hex');

  return {
    timestamp,
    radarVersion: 'Sovereign God\'s Eye v2.1.0 (Clean-Room)',
    totalTargets: nodes.length,
    layers: layerCounts,
    nodes,
    shaderModes: ['GRID', 'CRT', 'FLIR', 'NVG'],
    integritySeal
  };
}
