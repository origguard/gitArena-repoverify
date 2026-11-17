import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/database.mjs';
import { PERMISSIVE_LICENSES, findRepoInDb, inspectRepository } from './repo-service.mjs';
import { getCachedMaintainerHealthSync, fetchMaintainerHealth } from './maintainer-telemetry.mjs';
import { fetchCiTelemetry } from './ci-telemetry.mjs';

/**
 * Moteur de Tournoi Multi-Dépôts (4 à 8 candidats) & Scoring par Profil Métier
 * Implémente le format "Survival Funnel" (3 filtres éliminatoires) + Matrice Lead Magnet.
 * 100% Natif Node.js ESM, zéro dépendance NPM.
 */

export const TOURNAMENT_PROFILES = {
  enterprise: {
    id: 'enterprise',
    label: '🏦 Entreprise & Production',
    description: 'Priorité absolue : Licence commerciale BigCode, 0 CVE critique, CI verte, Lockfile et Bus Factor faible.'
  },
  startup: {
    id: 'startup',
    label: '⚡ Startup & Vélocité MVP',
    description: 'Priorité : Fraîcheur des commits, documentation, exemples, popularité et facilité d\'adoption.'
  },
  ai_training: {
    id: 'ai_training',
    label: '🧠 Training LLM & RAG',
    description: 'Priorité : Conformité stricte The Stack v2, volume de fichiers/tokens et qualité structurelle.'
  },
  balanced: {
    id: 'balanced',
    label: '⚖️ Équilibré (Standard)',
    description: 'Pondération équilibrée entre Score Potentiel IA, Rating ELO, Licence et Santé CI.'
  }
};

function readCachesForRepo(fullName) {
  const db = getDb();
  let ci = null;
  let intel = null;
  let osv = null;
  const maintainer = getCachedMaintainerHealthSync(fullName);

  try {
    const ciRow = db.prepare('SELECT * FROM ci_telemetry_cache WHERE full_name = ?').get(fullName);
    if (ciRow) {
      ci = {
        available: true,
        ciPassRate: ciRow.ci_pass_rate,
        lastRunStatus: ciRow.last_run_status
      };
    }
  } catch { /* ignore */ }

  try {
    const gRow = db.prepare('SELECT * FROM gitingest_cache WHERE full_name = ?').get(fullName);
    if (gRow) {
      const ph = JSON.parse(gRow.project_health_json || '{}');
      const deps = JSON.parse(gRow.dependencies_json || '{}');
      intel = {
        available: true,
        maturityScore: gRow.maturity_score,
        filesAnalyzed: gRow.files_analyzed,
        estimatedTokens: gRow.estimated_tokens,
        hasLockfile: Boolean(ph.hasLockfile),
        hasTests: Boolean(ph.hasTests),
        hasCI: Boolean(ph.hasCI),
        hasDocsDir: Boolean(ph.hasDocsDir),
        hasExamples: Boolean(ph.hasExamples),
        dependencies: deps
      };
    }
  } catch { /* ignore */ }

  if (intel && intel.dependencies && Array.isArray(intel.dependencies.runtime) && intel.dependencies.runtime.length > 0) {
    try {
      const placeholders = intel.dependencies.runtime.slice(0, 25).map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT package_name, vuln_count, max_severity
        FROM osv_vuln_cache
        WHERE package_name IN (${placeholders})
      `).all(...intel.dependencies.runtime.slice(0, 25));
      if (rows.length > 0) {
        let total = 0;
        let maxSev = 'NONE';
        const rank = { CRITICAL: 4, HIGH: 3, MODERATE: 2, LOW: 1, NONE: 0 };
        for (const r of rows) {
          total += r.vuln_count || 0;
          if ((rank[r.max_severity] || 0) > (rank[maxSev] || 0)) maxSev = r.max_severity;
        }
        osv = { scanned: true, totalVulnerabilities: total, maxSeverity: maxSev };
      }
    } catch { /* ignore */ }
  }

  return { ci, intel, osv, maintainer };
}

export function computeProfileScore(candidate, profileKey = 'enterprise') {
  const baseAi = Number(candidate.aiScore) || 0;
  const eloBonus = ((Number(candidate.elo) || 1500) - 1500) * 0.04;
  const licScore = candidate.commercialSafe ? 20 : -25;
  const freshness = candidate.daysSincePush <= 30 ? 15 : (candidate.daysSincePush <= 90 ? 10 : (candidate.daysSincePush <= 180 ? 4 : -15));
  const ciBonus = candidate.ciStatus === 'SUCCESS' ? 10 : (candidate.ciStatus === 'FAILURE' ? -15 : 2);
  const cvePenalty = candidate.cveMaxSeverity === 'CRITICAL' ? -20 : (candidate.cveMaxSeverity === 'HIGH' ? -12 : (candidate.cveCount === 0 ? 8 : -4));
  const busBonus = candidate.busFactorRisk === 'LOW' ? 8 : (candidate.busFactorRisk === 'HIGH' ? -10 : 2);
  const lockBonus = candidate.hasLockfile ? 5 : 0;
  const docsBonus = (candidate.hasDocsDir || candidate.hasExamples) ? 8 : 0;

  let rawScore = 0;
  if (profileKey === 'enterprise') {
    rawScore = (baseAi * 0.42) + licScore + freshness + ciBonus + cvePenalty + busBonus + lockBonus;
  } else if (profileKey === 'startup') {
    rawScore = (baseAi * 0.55) + (candidate.commercialSafe ? 10 : -5) + (freshness * 1.4) + docsBonus + eloBonus;
  } else if (profileKey === 'ai_training') {
    const tokenBonus = candidate.estimatedTokens > 50000 ? 12 : 4;
    rawScore = (baseAi * 0.45) + (candidate.commercialSafe ? 25 : -40) + tokenBonus + freshness * 0.8;
  } else {
    rawScore = (baseAi * 0.6) + (candidate.commercialSafe ? 14 : -12) + freshness + eloBonus + ciBonus * 0.6;
  }

  const normalized = Math.round(Math.min(100, Math.max(0, rawScore)) * 100) / 100;
  return {
    profileScore: normalized,
    breakdown: {
      baseAi: Math.round(baseAi * 10) / 10,
      licenseImpact: licScore,
      freshnessImpact: freshness,
      ciImpact: ciBonus,
      securityImpact: cvePenalty,
      busFactorImpact: busBonus
    }
  };
}

export async function runMultiRepoTournament(options = {}) {
  const db = getDb();
  const profile = TOURNAMENT_PROFILES[options.profile] ? options.profile : 'enterprise';
  const limit = Math.min(8, Math.max(4, parseInt(options.limit, 10) || 6));
  const includeLiveChecks = options.includeLiveChecks !== false;

  let repoRows = [];
  let categoryLabel = options.category ? String(options.category).trim() : '';

  if (Array.isArray(options.repos) && options.repos.length > 0) {
    const uniqueSlugs = [...new Set(options.repos.map(s => String(s).trim()).filter(s => s.includes('/')))].slice(0, 8);
    for (const slug of uniqueSlugs) {
      let row = findRepoInDb(slug);
      if (!row && includeLiveChecks) {
        const [owner, name] = slug.split('/');
        const insp = await inspectRepository(owner, name, { includeLiveCi: false, persistHarness: false });
        if (insp.ok) row = insp.payload.repository;
      }
      if (row) repoRows.push(row);
    }
    if (!categoryLabel) categoryLabel = 'Shortlist Personnalisée';
  }

  if (repoRows.length < 4) {
    if (categoryLabel && categoryLabel !== 'Shortlist Personnalisée') {
      repoRows = db.prepare(`
        SELECT * FROM repositories
        WHERE category = ?
        ORDER BY ai_potential_score DESC, stars DESC
        LIMIT ?
      `).all(categoryLabel, limit);
    }
    if (repoRows.length < 4) {
      categoryLabel = categoryLabel || 'Élite Multi-Catégories';
      repoRows = db.prepare(`
        SELECT * FROM repositories
        ORDER BY ai_potential_score DESC, elo_rating DESC
        LIMIT ?
      `).all(limit);
    }
  }

  // Enrichir chaque candidat
  const candidates = await Promise.all(repoRows.map(async (r) => {
    const caches = readCachesForRepo(r.full_name);
    let ci = caches.ci;
    let maintainer = caches.maintainer;

    if (includeLiveChecks) {
      if (!ci) ci = await fetchCiTelemetry(r.owner, r.name);
      if (!maintainer) maintainer = await fetchMaintainerHealth(r.owner, r.name);
    }

    const licLower = String(r.license || '').toLowerCase();
    const commercialSafe = PERMISSIVE_LICENSES.includes(licLower);
    const daysSincePush = Math.max(0, Math.round((Date.now() - new Date(r.pushed_at || Date.now()).getTime()) / 86400000));

    const enriched = {
      id: r.id,
      fullName: r.full_name,
      owner: r.owner,
      name: r.name,
      stars: r.stars || 0,
      forks: r.forks || 0,
      language: r.language || 'Code',
      license: r.license || 'Non spécifiée',
      commercialSafe,
      category: r.category,
      aiScore: r.ai_potential_score || 0,
      elo: r.elo_rating || 1500,
      daysSincePush,
      ciStatus: ci?.available ? (ci.lastRunStatus || 'UNKNOWN') : 'AUDIT_LOCAL',
      ciPassRate: ci?.available ? ci.ciPassRate : null,
      busFactorRisk: maintainer?.busFactorRisk || 'UNKNOWN',
      contributorsSampled: maintainer?.contributorsSampled || 0,
      topContributorShare: maintainer?.topContributorShare ?? null,
      latestReleaseTag: maintainer?.latestReleaseTag || null,
      cveCount: caches.osv?.scanned ? caches.osv.totalVulnerabilities : 0,
      cveMaxSeverity: caches.osv?.scanned ? caches.osv.maxSeverity : 'NONE',
      cveScanned: Boolean(caches.osv?.scanned),
      maturityScore: caches.intel?.maturityScore ?? null,
      estimatedTokens: caches.intel?.estimatedTokens || 0,
      hasLockfile: Boolean(caches.intel?.hasLockfile),
      hasDocsDir: Boolean(caches.intel?.hasDocsDir),
      hasExamples: Boolean(caches.intel?.hasExamples),
      eliminatedAtStage: null,
      eliminationReason: null
    };

    const scoring = computeProfileScore(enriched, profile);
    enriched.profileScore = scoring.profileScore;
    enriched.scoreBreakdown = scoring.breakdown;
    return enriched;
  }));

  // ===== SURVIVAL FUNNEL EN 3 ÉTAPES =====
  const stages = [];

  // ÉTAPE 1 : Porte Juridique (Licence Commerciale BigCode)
  const stage1Eliminated = [];
  const stage1Survivors = [];
  for (const c of candidates) {
    const strictLegal = profile === 'enterprise' || profile === 'ai_training' || profile === 'balanced';
    if (strictLegal && !c.commercialSafe) {
      c.eliminatedAtStage = 1;
      c.eliminationReason = `Licence ${c.license} non permissive (risque copyleft / hors BigCode)`;
      stage1Eliminated.push(c);
    } else {
      stage1Survivors.push(c);
    }
  }
  stages.push({
    stageNumber: 1,
    name: 'Porte Juridique (Licences Commerciales BigCode)',
    rule: 'Élimine les licences copyleft (GPL/AGPL) ou absentes.',
    survivors: stage1Survivors.map(c => c.fullName),
    eliminated: stage1Eliminated.map(c => ({ fullName: c.fullName, reason: c.eliminationReason }))
  });

  // ÉTAPE 2 : Porte Santé & Maintenance (Fraîcheur <= 180j & CI non cassée)
  const stage2Eliminated = [];
  const stage2Survivors = [];
  const pool2 = stage1Survivors.length >= 2 ? stage1Survivors : candidates;

  for (const c of pool2) {
    if (c.daysSincePush > 180) {
      c.eliminatedAtStage = 2;
      c.eliminationReason = `Inactif depuis ${c.daysSincePush} jours (> 180j)`;
      stage2Eliminated.push(c);
    } else if (c.ciStatus === 'FAILURE') {
      c.eliminatedAtStage = 2;
      c.eliminationReason = 'Dernier workflow GitHub Actions en échec (FAILURE)';
      stage2Eliminated.push(c);
    } else {
      stage2Survivors.push(c);
    }
  }
  stages.push({
    stageNumber: 2,
    name: 'Porte Santé, CI/CD & Activité',
    rule: 'Élimine les dépôts inactifs (> 180j) ou avec CI GitHub Actions en échec.',
    survivors: stage2Survivors.map(c => c.fullName),
    eliminated: stage2Eliminated.map(c => ({ fullName: c.fullName, reason: c.eliminationReason }))
  });

  // ÉTAPE 3 : Finale Supply-Chain & Score Profil (Top 3 Podium)
  const finalistsPool = stage2Survivors.length >= 2 ? stage2Survivors : pool2;
  const rankedFinalists = [...finalistsPool].sort((a, b) =>
    (b.profileScore - a.profileScore) || (b.elo - a.elo) || (b.stars - a.stars)
  );

  // Classement global complet (survivants en premier triés par profileScore, puis éliminés)
  const fullRanking = [...candidates].sort((a, b) => {
    const elimA = a.eliminatedAtStage ? 0 : 1;
    const elimB = b.eliminatedAtStage ? 0 : 1;
    if (elimA !== elimB) return elimB - elimA;
    return (b.profileScore - a.profileScore) || (b.elo - a.elo);
  });

  const podium = rankedFinalists.slice(0, 3);
  const champion = podium[0] || fullRanking[0];

  stages.push({
    stageNumber: 3,
    name: `Finale & Podium (${TOURNAMENT_PROFILES[profile].label})`,
    rule: 'Classement pondéré selon le profil métier, OSV.dev, Bus Factor et ELO.',
    podium: podium.map((c, idx) => ({
      rank: idx + 1,
      fullName: c.fullName,
      profileScore: c.profileScore,
      license: c.license,
      busFactorRisk: c.busFactorRisk
    }))
  });

  const tournamentId = randomUUID();
  const createdAt = new Date().toISOString();
  const seal = createHash('sha256')
    .update(`${tournamentId}:${profile}:${fullRanking.map(c => `${c.fullName}:${c.profileScore}`).join('|')}`)
    .digest('hex');

  const tournamentResult = {
    tournamentId,
    profile,
    profileMeta: TOURNAMENT_PROFILES[profile],
    category: categoryLabel,
    candidatesCount: fullRanking.length,
    champion,
    podium,
    stages,
    ranking: fullRanking,
    seal,
    createdAt
  };

  try {
    db.prepare(`
      INSERT INTO arena_tournaments (id, profile, category, repos_json, stages_json, winner_full_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      tournamentId,
      profile,
      categoryLabel,
      JSON.stringify(fullRanking),
      JSON.stringify(stages),
      champion?.fullName || null,
      createdAt
    );
  } catch { /* ignore if schema missing in isolated unit test */ }

  return tournamentResult;
}

export function getTournamentById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM arena_tournaments WHERE id = ?').get(id);
  if (!row) return null;
  const ranking = JSON.parse(row.repos_json || '[]');
  const stages = JSON.parse(row.stages_json || '[]');
  return {
    tournamentId: row.id,
    profile: row.profile,
    profileMeta: TOURNAMENT_PROFILES[row.profile] || TOURNAMENT_PROFILES.enterprise,
    category: row.category,
    candidatesCount: ranking.length,
    champion: ranking[0] || null,
    podium: ranking.slice(0, 3),
    stages,
    ranking,
    createdAt: row.created_at
  };
}

export function buildTournamentMarkdown(t) {
  const lines = [
    `# Matrice Comparative Multi-Dépôts — RepoVerify / GitArena`,
    ``,
    `- **ID Tournoi** : \`${t.tournamentId}\``,
    `- **Profil d'évaluation** : ${t.profileMeta?.label || t.profile} — *${t.profileMeta?.description || ''}*`,
    `- **Catégorie / Shortlist** : ${t.category}`,
    `- **Date** : ${t.createdAt}`,
    t.seal ? `- **Sceau SHA-256** : \`${t.seal}\`` : null,
    ``,
    `## 🏆 Champion Recommandé : **${t.champion?.fullName || 'N/A'}** (${t.champion?.profileScore ?? 0}/100)`,
    ``,
    `## 1. Classement Complet & Risques`,
    `| Rang | Dépôt | Score Profil | Score IA | Licence | CI/CD | Bus Factor | Statut |`,
    `| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :--- |`
  ];

  t.ranking.forEach((c, idx) => {
    const status = c.eliminatedAtStage ? `❌ Éliminé (Étape ${c.eliminatedAtStage} : ${c.eliminationReason})` : '✅ Survivant';
    lines.push(`| #${idx + 1} | **${c.fullName}** | **${c.profileScore}/100** | ${c.aiScore}/100 | \`${c.license}\` | ${c.ciStatus} | ${c.busFactorRisk} | ${status} |`);
  });

  lines.push(``, `## 2. Entonnoir d'Élimination (Survival Funnel)`);
  for (const st of t.stages) {
    lines.push(`### Étape ${st.stageNumber} : ${st.name}`);
    lines.push(`- *Règle* : ${st.rule}`);
    if (st.eliminated && st.eliminated.length > 0) {
      lines.push(`- *Éliminés* : ${st.eliminated.map(e => `\`${e.fullName}\` (${e.reason})`).join(', ')}`);
    } else if (st.podium) {
      lines.push(`- *Podium* : ${st.podium.map(p => `#${p.rank} **${p.fullName}** (${p.profileScore}/100)`).join(' • ')}`);
    } else {
      lines.push(`- *Tous les candidats ont franchi cette étape.*`);
    }
  }

  return lines.filter(l => l !== null).join('\n');
}
