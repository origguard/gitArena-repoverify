/**
 * RepoVerify / GitArena Client Application — Mode Souverain 100% Vanilla JS
 * Inspection Chirurgicale, CI/CD Live, OSV.dev CVE, PixelRAG, Arène ELO, Radar God's Eye & FTS5
 */

let currentInspectedRepo = null;
let currentDuel = null;
let explorerOffset = 0;
const EXPLORER_LIMIT = 24;
let explorerTotal = 0;
let explorerDebounceTimer = null;
let currentRadarShader = 'GRID';

document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadFiltersMeta();
  loadRecentRepos();

  const hash = window.location.hash.replace(/^#/, '');
  if (hash.startsWith('inspect/')) {
    const repoPath = hash.replace('inspect/', '');
    if (repoPath.includes('/')) {
      inspectDirect(repoPath);
      return;
    }
  } else if (hash === 'arena') {
    switchTab('arena');
  } else if (hash === 'radar') {
    switchTab('radar');
  } else if (hash === 'explorer') {
    switchTab('explorer');
  }

  inspectDirect('huggingface/transformers');
});

function switchTab(tabName) {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });

  if (tabName === 'arena' && !currentDuel) {
    loadArenaDuel(false);
    loadArenaHistory();
  } else if (tabName === 'radar') {
    loadRadarView();
  } else if (tabName === 'explorer') {
    searchExplorer();
  }
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('kpiTotal').textContent = data.totalRepositories || 0;
    document.getElementById('kpiDuels').textContent = data.totalDuelsPlayed || 0;
    document.getElementById('kpiLegal').textContent = `${data.commercialSafePercentage || 0}%`;
  } catch (err) {
    console.warn('[STATS] Erreur de chargement', err);
  }
}

async function loadFiltersMeta() {
  try {
    const res = await fetch('/api/filters');
    if (!res.ok) return;
    const data = await res.json();

    const langSelect = document.getElementById('explorerLang');
    const catSelect = document.getElementById('explorerCategory');
    const radarCatSelect = document.getElementById('radarCategorySelect');
    const tournamentCatSelect = document.getElementById('tournamentCategory');

    if (langSelect && Array.isArray(data.languages)) {
      data.languages.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.language;
        opt.textContent = `${item.language} (${item.count})`;
        langSelect.appendChild(opt);
      });
    }

    if (Array.isArray(data.categories)) {
      data.categories.forEach(item => {
        if (catSelect) {
          const opt = document.createElement('option');
          opt.value = item.category;
          opt.textContent = `${item.category} (${item.count})`;
          catSelect.appendChild(opt);
        }
        if (radarCatSelect) {
          const optR = document.createElement('option');
          optR.value = item.category;
          optR.textContent = `${item.category} (${item.count})`;
          radarCatSelect.appendChild(optR);
        }
        if (tournamentCatSelect) {
          const optT = document.createElement('option');
          optT.value = item.category;
          optT.textContent = `${item.category} (${item.count})`;
          tournamentCatSelect.appendChild(optT);
        }
      });
    }
  } catch (err) {
    console.warn('[FILTERS] Erreur:', err);
  }
}

async function loadRecentRepos() {
  const section = document.getElementById('recentSection');
  const grid = document.getElementById('recentGrid');
  try {
    const res = await fetch('/api/repos/recent');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.items || data.items.length === 0) return;

    section.style.display = 'block';
    grid.innerHTML = data.items.map(repo => `
      <div class="recent-card" onclick="inspectDirect('${escapeHtml(repo.full_name)}')">
        <div class="recent-card-name">${escapeHtml(repo.full_name)}</div>
        <div class="recent-card-meta">
          <span>⭐ ${(repo.stars || 0).toLocaleString()}</span>
          <span>${escapeHtml(repo.language || 'Code')}</span>
          <span style="color: var(--accent-green);">${repo.ai_potential_score}/100</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.warn('[RECENT] Erreur:', err);
  }
}

/* ==================== EXPLORATEUR FTS5 SERVEUR ==================== */

function debouncedExplorerSearch() {
  clearTimeout(explorerDebounceTimer);
  explorerDebounceTimer = setTimeout(() => {
    explorerOffset = 0;
    searchExplorer();
  }, 180);
}

function resetAndSearchExplorer() {
  explorerOffset = 0;
  searchExplorer();
}

function changeExplorerPage(direction) {
  const nextOffset = explorerOffset + (direction * EXPLORER_LIMIT);
  if (nextOffset < 0 || nextOffset >= explorerTotal) return;
  explorerOffset = nextOffset;
  searchExplorer();
}

async function searchExplorer() {
  const grid = document.getElementById('catalogGrid');
  const perfEl = document.getElementById('explorerPerfMeta');
  const pageInfo = document.getElementById('explorerPageInfo');
  if (!grid) return;

  const q = document.getElementById('explorerQuery')?.value.trim() || '';
  const lang = document.getElementById('explorerLang')?.value || '';
  const category = document.getElementById('explorerCategory')?.value || '';
  const license = document.getElementById('explorerLicense')?.value || '';
  const sort = document.getElementById('explorerSort')?.value || 'ai_score';

  const params = new URLSearchParams({
    limit: String(EXPLORER_LIMIT),
    offset: String(explorerOffset),
    sort
  });
  if (q) params.set('q', q);
  if (lang) params.set('lang', lang);
  if (category) params.set('category', category);
  if (license) params.set('license', license);

  try {
    const res = await fetch(`/api/repos?${params.toString()}`);
    if (!res.ok) throw new Error('Erreur HTTP ' + res.status);
    const data = await res.json();
    explorerTotal = data.total || 0;

    if (perfEl) {
      perfEl.textContent = `${explorerTotal} dépôt(s) trouvés en ${data.queryTimeMs} ms via SQLite FTS5`;
    }
    if (pageInfo) {
      const startIdx = explorerTotal === 0 ? 0 : explorerOffset + 1;
      const endIdx = Math.min(explorerTotal, explorerOffset + (data.items?.length || 0));
      pageInfo.textContent = `Affichage ${startIdx}–${endIdx} sur ${explorerTotal}`;
    }

    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    if (prevBtn) prevBtn.disabled = explorerOffset === 0;
    if (nextBtn) nextBtn.disabled = explorerOffset + EXPLORER_LIMIT >= explorerTotal;

    renderCatalog(data.items || []);
  } catch (err) {
    grid.innerHTML = `<div class="state-empty">Impossible de charger le catalogue : ${escapeHtml(err.message)}</div>`;
  }
}

function renderCatalog(items) {
  const grid = document.getElementById('catalogGrid');
  if (!items || items.length === 0) {
    grid.innerHTML = '<div class="state-empty">Aucun dépôt ne correspond aux filtres sélectionnés.</div>';
    return;
  }

  grid.innerHTML = items.map(repo => `
    <div class="dir-card" onclick="inspectFromExplorer('${escapeHtml(repo.full_name)}')">
      <div>
        <div class="dir-card-head">
          <span class="dir-card-title">${escapeHtml(repo.full_name)}</span>
          <span style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--accent-green); font-weight: bold;">
            ${repo.ai_potential_score}/100 • ELO ${repo.elo_rating}
          </span>
        </div>
        <p class="dir-card-desc">${escapeHtml(repo.description || 'Projet qualifié pour ingénierie et production.')}</p>
      </div>
      <div class="dir-card-footer">
        <span>⭐ ${(repo.stars || 0).toLocaleString()}</span>
        <span>${escapeHtml(repo.language || 'Code')} • ${escapeHtml(repo.license || 'Permissive')}</span>
        <span style="color: var(--accent-cyan); font-weight: bold;">Inspecter ➔</span>
      </div>
    </div>
  `).join('');
}

function inspectFromExplorer(fullName) {
  switchTab('inspector');
  inspectDirect(fullName);
}

/* ==================== INSPECTEUR CHIRURGICAL ==================== */

function triggerInspection() {
  const raw = document.getElementById('inspectInput').value.trim();
  if (!raw) return;

  const cleanName = raw
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .trim();

  if (!cleanName || !cleanName.includes('/')) {
    document.getElementById('reportContainer').innerHTML = `
      <div class="report-header" style="border-color: var(--accent-amber);">
        <div>
          <h3 style="color: var(--accent-amber); margin-bottom: 0.5rem;">Format invalide</h3>
          <p style="color: var(--text-muted); font-size: 0.9rem;">
            Veuillez entrer un dépôt au format <strong>owner/repo</strong>, URL HTTPS ou SSH.
          </p>
        </div>
      </div>`;
    return;
  }

  inspectDirect(cleanName);
}

async function inspectDirect(fullName) {
  switchTab('inspector');
  const container = document.getElementById('reportContainer');
  document.getElementById('inspectInput').value = fullName;

  container.innerHTML = `
    <div class="state-loading">
      <p style="font-size: 1.1rem; color: #fff; margin-bottom: 0.5rem;">
        Inspection chirurgicale de <strong>${escapeHtml(fullName)}</strong> en cours...
      </p>
      <p style="color: var(--text-dim); font-size: 0.85rem;">
        Télémétrie GitHub Actions, audit mécanique, conformité légale et synthèse PixelRAG...
      </p>
    </div>`;

  try {
    const parts = fullName.split('/');
    if (parts.length < 2) {
      throw new Error("Format 'owner/repo' requis (ex: huggingface/transformers)");
    }
    const [owner, name] = parts;

    const res = await fetch(`/api/inspect/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Dépôt introuvable (Code HTTP ${res.status})`);
    }

    const data = await res.json();
    currentInspectedRepo = data;
    renderInspectionReport(data);

    loadCodeIntelligence(owner, name);
    window.history.replaceState(null, '', `#inspect/${fullName}`);
    loadRecentRepos();
    loadStats();
  } catch (err) {
    container.innerHTML = `
      <div class="report-header" style="border-color: var(--accent-pink);">
        <div>
          <h3 style="color: var(--accent-pink); margin-bottom: 0.5rem;">Échec de l'inspection</h3>
          <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 0.75rem;">${escapeHtml(err.message)}</p>
        </div>
      </div>`;
  }
}

function renderInspectionReport(data) {
  const repo = data.repository;
  const health = data.health;
  const ciTel = health.ciTelemetry || {};
  const legal = data.legalAndSecurity;
  const alts = data.modernAlternatives || [];
  const container = document.getElementById('reportContainer');

  const legalBadgeClass = legal.commercialSafe ? 'badge-legal-safe' : 'badge-legal-warn';
  const legalLabel = legal.commercialSafe ? '✓ Commercial Safe (BigCode Compliant)' : '⚠ Licence Restrictive / Copyleft';

  const ciBadgeHtml = ciTel.available
    ? `<span class="badge-tag ${ciTel.lastRunStatus === 'SUCCESS' ? 'badge-exit0' : 'badge-legal-warn'}">
         ⚙️ CI GitHub Actions : ${escapeHtml(ciTel.lastRunStatus)} (${ciTel.ciPassRate ?? '—'}%)
       </span>`
    : `<span class="badge-tag" style="background: rgba(255,255,255,0.04); color: var(--text-muted); border: 1px solid var(--border-subtle);">
         ⚙️ CI : ${escapeHtml(ciTel.source || 'Audit Structurel')}
       </span>`;

  const recentRunsHtml = ciTel.available && Array.isArray(ciTel.recentRuns) && ciTel.recentRuns.length > 0
    ? `<div style="margin-top: 0.75rem; padding-top: 0.6rem; border-top: 1px solid var(--border-subtle);">
         <div style="font-size: 0.72rem; color: var(--text-dim); margin-bottom: 0.35rem;">Derniers runs GitHub Actions :</div>
         ${ciTel.recentRuns.slice(0, 3).map(r => `
           <div style="display:flex; justify-content:space-between; font-size:0.74rem; padding: 0.15rem 0;">
             <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" style="color: var(--text-muted); text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width: 190px;">
               ${escapeHtml(r.name)}
             </a>
             <span style="font-family:var(--font-mono); color: ${r.conclusion === 'success' ? 'var(--accent-green)' : (r.conclusion === 'failure' ? 'var(--accent-pink)' : 'var(--accent-amber)')};">
               ${escapeHtml((r.conclusion || r.status).toUpperCase())}
             </span>
           </div>
         `).join('')}
       </div>`
    : '';

  container.innerHTML = `
    <div class="report-header">
      <div class="report-title-area">
        <div class="report-repo-name">
          ${escapeHtml(repo.full_name)}
          <a href="https://github.com/${escapeHtml(repo.full_name)}" target="_blank" rel="noopener" style="color: var(--text-muted); font-size: 0.9rem; text-decoration: none;">
            ↗ GitHub
          </a>
        </div>
        <p style="color: var(--text-muted); font-size: 0.9rem;">${escapeHtml(repo.description || 'Dépôt open-source qualifié.')}</p>
        <div class="report-badges">
          <span class="badge-tag ${health.environment.exitCode === 0 ? 'badge-exit0' : 'badge-legal-warn'}">
            ${health.environment.exitCode === 0 ? '✓ Exit Code 0 (Vérifié)' : '⚠ Vérification Requise'}
          </span>
          <span class="badge-tag ${legalBadgeClass}">${legalLabel}</span>
          ${ciBadgeHtml}
          <span class="badge-tag" style="background: rgba(255,255,255,0.05); color: #fff; border: 1px solid var(--border-subtle);">
            ${escapeHtml(repo.category)}
          </span>
          ${data.auditReceipt.autoIndexedLive ? `<span class="badge-tag badge-jit">⚡ Indexé en direct depuis GitHub API</span>` : ''}
        </div>

        <div class="report-actions-bar">
          <button class="report-action-btn" onclick="copyFullReport()">📋 Copier Rapport</button>
          <a href="/api/inspect/${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}/export?format=md" class="report-action-btn report-action-link" download>
            📄 Exporter Audit (.md)
          </a>
          <a href="/api/inspect/${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}/export?format=json" class="report-action-btn" download>
            🧾 Export JSON Signé
          </a>
          <button class="report-action-btn" onclick="compareRepoInArena('${escapeHtml(repo.full_name)}')">
            ⚔️ Comparer dans l'Arène
          </button>
          <button class="report-action-btn" onclick="triggerSandboxVerification('${escapeHtml(repo.full_name)}')">
            🧪 Sandbox Exit 0
          </button>
          <button class="report-action-btn" onclick="copyBadgeMarkdown('${escapeHtml(repo.full_name)}')">
            🛡️ Copier Badge
          </button>
        </div>
        <div id="sandboxResultBox" style="margin-top:0.75rem;"></div>
      </div>

      <div class="report-kpis">
        <div class="kpi-item">
          <span class="kpi-label">SCORE IA</span>
          <span class="kpi-val" style="font-size: 1.25rem;">${repo.ai_potential_score}/100</span>
        </div>
        <div class="kpi-item">
          <span class="kpi-label">ELO ARÈNE</span>
          <span class="kpi-val" style="color: var(--accent-cyan); font-size: 1.25rem;">${repo.elo_rating}</span>
        </div>
        <div class="kpi-item">
          <span class="kpi-label">STARS</span>
          <span class="kpi-val" style="color: #fff; font-size: 1.25rem;">${(repo.stars || 0).toLocaleString()}</span>
        </div>
      </div>
    </div>

    <div class="diagnostic-grid">
      <div class="diag-card">
        <div>
          <div class="diag-card-title"><span>🩺</span> Santé d'Exécutabilité &amp; CI/CD</div>
          <ul class="diag-list">
            <li class="diag-item">
              <span class="diag-key">Dernier commit :</span>
              <span class="diag-val" style="color: ${health.daysSinceLastPush < 90 ? 'var(--accent-green)' : 'var(--accent-amber)'};">
                il y a ${health.daysSinceLastPush} jours
              </span>
            </li>
            <li class="diag-item">
              <span class="diag-key">Runtime :</span>
              <span class="diag-val">${escapeHtml(health.environment.runtime)}</span>
            </li>
            <li class="diag-item">
              <span class="diag-key">Fiabilité mesurée :</span>
              <span class="diag-val" style="color: var(--accent-green);">${escapeHtml(health.environment.passRate)}</span>
            </li>
            <li class="diag-item">
              <span class="diag-key">RAM estimée :</span>
              <span class="diag-val">${health.environment.ramMinMb} Mo</span>
            </li>
            ${health.maintainerHealth && health.maintainerHealth.available ? `
            <li class="diag-item">
              <span class="diag-key">Bus Factor (Mainteneurs) :</span>
              <span class="diag-val" style="color: ${health.maintainerHealth.busFactorRisk === 'LOW' ? 'var(--accent-green)' : (health.maintainerHealth.busFactorRisk === 'HIGH' ? 'var(--accent-pink)' : 'var(--accent-amber)')};">
                Risque ${escapeHtml(health.maintainerHealth.busFactorRisk)} (${health.maintainerHealth.contributorsSampled} contrib. • Top ${health.maintainerHealth.topContributorShare}%)
              </span>
            </li>
            <li class="diag-item">
              <span class="diag-key">Dernière Release :</span>
              <span class="diag-val">${escapeHtml(health.maintainerHealth.latestReleaseTag || 'Aucune')} ${health.maintainerHealth.daysSinceLastRelease !== null ? `(il y a ${health.maintainerHealth.daysSinceLastRelease}j)` : ''}</span>
            </li>` : ''}
          </ul>
          ${recentRunsHtml}
        </div>
        <div style="margin-top: 1rem; font-size: 0.75rem; color: var(--text-dim);">
          ${escapeHtml(health.summary)}
        </div>
      </div>

      <div class="diag-card">
        <div>
          <div class="diag-card-title"><span>🛡️</span> Audit Juridique &amp; Propriété</div>
          <ul class="diag-list">
            <li class="diag-item">
              <span class="diag-key">Licence SPDX :</span>
              <span class="diag-val" style="color: var(--accent-cyan);">${escapeHtml(legal.licenseSpdx)}</span>
            </li>
            <li class="diag-item">
              <span class="diag-key">Usage Commercial :</span>
              <span class="diag-val" style="color: ${legal.commercialSafe ? 'var(--accent-green)' : 'var(--accent-amber)'};">
                ${legal.commercialSafe ? 'AUTORISÉ SANS RESTRICTION' : 'RISQUE VIRAL / À VÉRIFIER'}
              </span>
            </li>
            <li class="diag-item">
              <span class="diag-key">Entraînement IA :</span>
              <span class="diag-val" style="color: ${legal.bigCodeCompliant ? 'var(--accent-green)' : 'var(--accent-amber)'};">
                ${legal.bigCodeCompliant ? 'CONFORME THE STACK v2' : 'NON RECOMMANDÉ'}
              </span>
            </li>
          </ul>
        </div>
        <div style="margin-top: 1rem; font-size: 0.75rem; color: var(--text-muted); background: var(--bg-elevated); padding: 0.5rem; border-radius: 4px;">
          ${escapeHtml(legal.recommendation)}
        </div>
      </div>

      <div class="diag-card">
        <div>
          <div class="diag-card-title"><span>⚡</span> Déploiement Vérifié</div>
          <p style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.5rem;">
            Commandes extraites pour démarrer et tester localement :
          </p>
          <div class="quickstart-box">
            <button class="copy-cmd-btn" onclick="copyQuickstart()">Copier</button>
            <code>${health.quickstart.map(c => escapeHtml(c)).join('\n')}</code>
          </div>
        </div>
        <div style="margin-top: 0.75rem; font-family: var(--font-mono); font-size: 0.68rem; color: var(--text-dim);">
          Quittance SHA-256 : ${data.auditReceipt.reportHash.substring(0, 20)}...
        </div>
      </div>
    </div>

    <div id="codeIntelContainer">
      <div class="ci-section" style="opacity: 0.6;">
        <div class="ci-header">
          <div>
            <h3 style="font-size: 1.1rem; color: #fff; font-weight: 700;">🧬 Code Intelligence &amp; Supply-Chain OSV.dev</h3>
            <p style="font-size: 0.8rem; color: var(--text-muted);">Analyse structurelle, dépendances (npm/pip/Cargo/Go) et scan CVE en cours...</p>
          </div>
          <div class="ci-loading-dots">⏳</div>
        </div>
      </div>
    </div>

    <div class="pixelrag-section">
      <div class="pixelrag-header">
        <div>
          <h3 style="font-size: 1.1rem; color: #fff; font-weight: 700;">🖼️ Échographie d'Architecture PixelRAG (Visual X-Ray)</h3>
          <p style="font-size: 0.8rem; color: var(--text-muted);">Rendu vectoriel sans perte : infrastructure, I/O et matrice de performance.</p>
        </div>
        <span style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-dim);">
          HASH : ${data.pixelRagArchitecture.tileHash.substring(0, 16)}...
        </span>
      </div>
      <div class="pixelrag-svg-wrap" id="pixelRagTileContainer">
        <p style="color: var(--text-dim);">Chargement du schéma...</p>
      </div>
    </div>

    <div class="alternatives-section">
      <h3 style="font-size: 1.1rem; color: #fff; font-weight: 700; margin-bottom: 0.35rem;">
        ⚖️ Alternatives dans la Catégorie (${escapeHtml(repo.category)})
      </h3>
      <table class="alt-table">
        <thead>
          <tr>
            <th>PROJET</th><th>STARS</th><th>SCORE IA</th><th>ELO</th><th>LANGAGE</th><th>LICENCE</th><th>ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          ${alts.length === 0 ? '<tr><td colspan="7" style="text-align:center; color:var(--text-dim);">Aucune alternative directe.</td></tr>' : ''}
          ${alts.map(alt => `
            <tr>
              <td><span class="alt-link" onclick="inspectDirect('${escapeHtml(alt.full_name)}')">${escapeHtml(alt.full_name)}</span></td>
              <td>${(alt.stars || 0).toLocaleString()}</td>
              <td style="color: var(--accent-green); font-weight: bold;">${alt.ai_potential_score}/100</td>
              <td style="color: var(--accent-cyan); font-family: var(--font-mono);">${alt.elo_rating}</td>
              <td>${escapeHtml(alt.language)}</td>
              <td>${escapeHtml(alt.license)}</td>
              <td style="display:flex; gap:0.35rem;">
                <button class="quick-pill" onclick="inspectDirect('${escapeHtml(alt.full_name)}')">Inspecter</button>
                <button class="quick-pill" onclick="compareTwoInArena('${escapeHtml(repo.full_name)}', '${escapeHtml(alt.full_name)}')">⚔️ Duel</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  loadPixelTileSvg(repo.owner, repo.name);
}

async function loadPixelTileSvg(owner, name) {
  const container = document.getElementById('pixelRagTileContainer');
  if (!container) return;
  try {
    const res = await fetch(`/api/pixelrag/tile/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error('Erreur SVG');
    container.innerHTML = await res.text();
  } catch (err) {
    container.innerHTML = `<p style="color:var(--accent-pink);">Erreur schéma : ${escapeHtml(err.message)}</p>`;
  }
}

async function loadCodeIntelligence(owner, name) {
  const container = document.getElementById('codeIntelContainer');
  if (!container) return;
  try {
    const res = await fetch(`/api/codeintel/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error('Erreur ' + res.status);
    const ci = await res.json();
    ci._repoName = `${owner}/${name}`;
    window._lastCodeIntel = ci;
    container.innerHTML = renderCodeIntelligence(ci);
  } catch (err) {
    container.innerHTML = renderCodeIntelligence({ available: false, _repoName: `${owner}/${name}` });
  }
}

function renderCodeIntelligence(ci) {
  if (!ci || !ci.available) {
    const repoName = ci?._repoName || '';
    const gitingestUrl = repoName ? `https://gitingest.com/${repoName}` : 'https://gitingest.com/';
    return `
      <div class="ci-section" style="opacity: 0.75;">
        <div class="ci-header">
          <div>
            <h3 style="font-size: 1.1rem; color: #fff; font-weight: 700;">🧬 Code Intelligence &amp; Supply-Chain</h3>
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">
              Analyse directe indisponible ou dépôt trop volumineux. Consulter sur GitIngest :
            </p>
          </div>
        </div>
        <div class="ci-actions-bar">
          <a href="${gitingestUrl}" target="_blank" rel="noopener" class="ci-action-btn ci-action-download">📂 Ouvrir sur GitIngest →</a>
        </div>
      </div>`;
  }

  const ph = ci.projectHealth || {};
  const checkIcon = (val) => val
    ? '<span style="color: var(--accent-green);">✓</span>'
    : '<span style="color: var(--text-dim);">✗</span>';

  const healthItems = [
    ['README', ph.hasReadme],
    ['LICENSE', ph.hasLicense],
    ['CI/CD', ph.hasCI],
    ['Tests', ph.hasTests],
    ['Dockerfile', ph.hasDockerfile],
    ['Lockfile', ph.hasLockfile],
    ['Documentation', ph.hasDocsDir],
    ['Exemples', ph.hasExamples],
    ['Contributing', ph.hasContributing],
    ['Security Policy', ph.hasSecurity],
  ];

  // Vulnérabilités OSV.dev
  const vuln = ci.vulnerabilities || {};
  let vulnBadgeHtml = `<span class="vuln-badge vuln-warn">OSV.dev non exécuté</span>`;
  if (vuln.scanned) {
    if (vuln.totalVulnerabilities === 0) {
      vulnBadgeHtml = `<span class="vuln-badge vuln-ok">✓ 0 CVE connue (${vuln.packagesChecked} paquets scannés)</span>`;
    } else {
      const cls = (vuln.maxSeverity === 'CRITICAL' || vuln.maxSeverity === 'HIGH') ? 'vuln-crit' : 'vuln-warn';
      vulnBadgeHtml = `<span class="vuln-badge ${cls}">⚠ ${vuln.totalVulnerabilities} CVE sur ${vuln.vulnerablePackages} paquet(s) (${escapeHtml(vuln.maxSeverity)})</span>`;
    }
  }

  const vulnFindingsHtml = (vuln.findings && vuln.findings.length > 0)
    ? `<div style="margin-top: 0.5rem; font-size: 0.74rem; background: rgba(255,51,102,0.06); border: 1px solid rgba(255,51,102,0.25); border-radius: 4px; padding: 0.5rem;">
         ${vuln.findings.slice(0, 4).map(f => `
           <div style="margin-bottom: 0.25rem;">
             <strong style="color: var(--accent-pink);">${escapeHtml(f.package)}</strong>
             <span style="color: var(--text-muted);">(${f.vulnCount} CVE • ${escapeHtml(f.maxSeverity)})</span> :
             <span style="color: var(--text-dim);">${escapeHtml(f.vulns[0]?.id || '')}</span>
           </div>
         `).join('')}
       </div>`
    : '';

  const depsHtml = ci.dependencies && ci.dependencies.count > 0
    ? `<div style="margin-top: 0.4rem;">
        <span class="diag-key">Gestionnaire :</span>
        <span class="diag-val" style="color: var(--accent-cyan);">${escapeHtml(ci.dependencies.manager)}</span>
        <span style="color: var(--text-dim); margin-left: 0.4rem;">(${ci.dependencies.count} paquets)</span>
       </div>
       ${ci.dependencies.runtime.length > 0 ? `
       <div style="margin-top: 0.35rem; display: flex; flex-wrap: wrap; gap: 0.25rem;">
         ${ci.dependencies.runtime.slice(0, 18).map(d => `<span class="dep-tag">${escapeHtml(d)}</span>`).join('')}
         ${ci.dependencies.runtime.length > 18 ? `<span class="dep-tag" style="opacity: 0.5;">+${ci.dependencies.runtime.length - 18}</span>` : ''}
       </div>` : ''}`
    : '<span style="color: var(--text-dim); font-size: 0.75rem;">Dépendances non détectées</span>';

  const scriptsEntries = Object.entries(ci.detectedScripts || {});
  const scriptsHtml = scriptsEntries.length > 0
    ? `<div style="margin-top: 0.5rem; font-size: 0.74rem; color: var(--text-muted);">
         <strong>Scripts détectés :</strong> ${scriptsEntries.map(([k, v]) => `<code>${escapeHtml(k)}</code>`).join(', ')}
       </div>`
    : '';

  const treePreview = ci.structure?.treePreview ? ci.structure.treePreview.substring(0, 1200) : '';

  return `
    <div class="ci-section">
      <div class="ci-header">
        <div>
          <h3 style="font-size: 1.1rem; color: #fff; font-weight: 700;">🧬 Code Intelligence &amp; Supply-Chain (OSV.dev)</h3>
          <p style="font-size: 0.8rem; color: var(--text-muted);">
            Source : ${escapeHtml(ci.source || 'GitIngest API')} • ${ci.aiContextFit ? escapeHtml(ci.aiContextFit.recommendedTier) : ''}
          </p>
        </div>
        <div style="text-align: right;">
          <div style="font-family: var(--font-mono); font-size: 1.5rem; color: var(--accent-cyan); font-weight: 700;">${ci.maturityScore}/100</div>
          <div style="font-size: 0.7rem; color: var(--text-dim);">Score Maturité</div>
        </div>
      </div>

      <div class="ci-grid">
        <div class="ci-card">
          <div class="diag-card-title"><span>📊</span> Métriques &amp; Supply-Chain</div>
          <ul class="diag-list">
            <li class="diag-item">
              <span class="diag-key">Fichiers / Tokens LLM :</span>
              <span class="diag-val" style="color: #fff;">${ci.filesAnalyzed.toLocaleString()} fichiers • ~${ci.estimatedTokens > 1000 ? Math.round(ci.estimatedTokens / 1000) + 'k' : ci.estimatedTokens} tok</span>
            </li>
            <li class="diag-item">
              <span class="diag-key">Lockfiles :</span>
              <span class="diag-val">${(ph.lockfiles && ph.lockfiles.length > 0) ? escapeHtml(ph.lockfiles.join(', ')) : 'Aucun détecté'}</span>
            </li>
            <li class="diag-item">
              <span class="diag-key">Sécurité OSV.dev :</span>
              <span>${vulnBadgeHtml}</span>
            </li>
          </ul>
          ${vulnFindingsHtml}
          <div style="margin-top: 0.65rem;">
            <div class="diag-card-title" style="margin-bottom: 0.25rem;"><span>📦</span> Dépendances Réelles</div>
            ${depsHtml}
            ${scriptsHtml}
          </div>
        </div>

        <div class="ci-card">
          <div class="diag-card-title"><span>🏥</span> Checklist de Maturité</div>
          <div class="ci-checklist">
            ${healthItems.map(([label, val]) => `<div class="ci-check-item">${checkIcon(val)} <span>${label}</span></div>`).join('')}
          </div>
          <div style="margin-top: 0.75rem; padding-top: 0.5rem; border-top: 1px solid var(--border-subtle);">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <div style="flex: 1; height: 6px; background: var(--bg-primary); border-radius: 3px; overflow: hidden;">
                <div style="width: ${ci.maturityScore}%; height: 100%; background: ${ci.maturityScore >= 70 ? 'var(--accent-green)' : ci.maturityScore >= 40 ? 'var(--accent-amber)' : 'var(--accent-pink)'}; border-radius: 3px;"></div>
              </div>
              <span style="font-size: 0.7rem; color: var(--text-dim);">${ci.maturityScore >= 70 ? 'Production-Ready' : ci.maturityScore >= 40 ? 'En Développement' : 'Expérimental'}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="ci-actions-bar">
        ${ci.digestUrl ? `<a href="${escapeHtml(ci.digestUrl)}" target="_blank" rel="noopener" class="ci-action-btn ci-action-download">📥 Digest Complet (.txt)</a>` : ''}
        <button class="ci-action-btn" onclick="copyCiSummary()">📋 Copier Résumé</button>
        ${treePreview ? `<button class="ci-action-btn" onclick="copyCiTree()">📂 Copier Arbre</button>` : ''}
        ${ci.fromCache ? '<span class="ci-cache-tag">⚡ Cache SQLite (< 10ms)</span>' : ''}
      </div>

      ${treePreview ? `
      <details class="ci-tree-details">
        <summary>📂 Structure du Répertoire (${ci.structure.totalTreeLines} entrées)</summary>
        <pre class="ci-tree-pre" id="ciTreeContent">${escapeHtml(treePreview)}</pre>
      </details>` : ''}
    </div>`;
}

/* ==================== ARÈNE & COMPARATEUR ELO + TOURNOI ==================== */

function switchArenaMode(mode) {
  const duelPanel = document.getElementById('arenaDuelPanel');
  const tourneyPanel = document.getElementById('arenaTournamentPanel');
  const duelBtn = document.getElementById('arenaModeDuelBtn');
  const tourneyBtn = document.getElementById('arenaModeTournamentBtn');

  if (mode === 'tournament') {
    if (duelPanel) duelPanel.style.display = 'none';
    if (tourneyPanel) tourneyPanel.style.display = 'block';
    duelBtn?.classList.remove('report-action-link');
    tourneyBtn?.classList.add('report-action-link');
  } else {
    if (duelPanel) duelPanel.style.display = 'block';
    if (tourneyPanel) tourneyPanel.style.display = 'none';
    duelBtn?.classList.add('report-action-link');
    tourneyBtn?.classList.remove('report-action-link');
  }
}

async function runArenaTournament() {
  const container = document.getElementById('tournamentContainer');
  if (!container) return;

  const profile = document.getElementById('tournamentProfile')?.value || 'enterprise';
  const category = document.getElementById('tournamentCategory')?.value || '';
  const limit = parseInt(document.getElementById('tournamentLimit')?.value || '6', 10);
  const rawRepos = document.getElementById('tournamentReposInput')?.value.trim() || '';
  const repos = rawRepos ? rawRepos.split(/[\s,]+/).map(s => s.trim()).filter(s => s.includes('/')) : [];

  container.innerHTML = `<div class="state-loading"><p>Exécution du Tournoi Survival (${repos.length > 0 ? repos.length : limit} dépôts) en cours...</p></div>`;

  try {
    const res = await fetch('/api/arena/tournament', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, category, limit, repos })
    });
    if (!res.ok) throw new Error('Erreur tournoi HTTP ' + res.status);
    const data = await res.json();
    renderTournamentResult(data);
  } catch (err) {
    container.innerHTML = `<div class="state-empty" style="color:var(--accent-pink);">Erreur tournoi : ${escapeHtml(err.message)}</div>`;
  }
}

function renderTournamentResult(t) {
  const container = document.getElementById('tournamentContainer');
  if (!container) return;

  const stagesHtml = (t.stages || []).map(st => `
    <div class="diag-card">
      <div class="diag-card-title"><span>🔹</span> Étape ${st.stageNumber} : ${escapeHtml(st.name)}</div>
      <p style="font-size:0.75rem; color:var(--text-muted); margin-bottom:0.5rem;">${escapeHtml(st.rule)}</p>
      ${st.eliminated && st.eliminated.length > 0 ? `
        <div style="font-size:0.76rem; color:var(--accent-pink);">
          <strong>Éliminés (${st.eliminated.length}) :</strong>
          ${st.eliminated.map(e => `<div style="margin-top:0.2rem;">✗ ${escapeHtml(e.fullName)} — <span style="color:var(--text-muted);">${escapeHtml(e.reason)}</span></div>`).join('')}
        </div>` : ''}
      ${st.survivors ? `<div style="font-size:0.76rem; color:var(--accent-green); margin-top:0.4rem;">✓ ${st.survivors.length} survivant(s)</div>` : ''}
      ${st.podium ? `
        <div style="font-size:0.78rem; color:var(--accent-cyan); margin-top:0.35rem;">
          ${st.podium.map(p => `<div>#${p.rank} <strong>${escapeHtml(p.fullName)}</strong> (${p.profileScore}/100)</div>`).join('')}
        </div>` : ''}
    </div>
  `).join('');

  container.innerHTML = `
    <div class="report-header" style="border-color: var(--accent-green);">
      <div class="report-title-area">
        <div style="font-family:var(--font-mono); font-size:0.75rem; color:var(--accent-green);">
          🏆 CHAMPION DU TOURNOI (${escapeHtml(t.profileMeta?.label || t.profile)})
        </div>
        <div class="report-repo-name">${escapeHtml(t.champion?.fullName || 'N/A')}</div>
        <p style="font-size:0.84rem; color:var(--text-muted);">
          Catégorie : ${escapeHtml(t.category)} • ${t.candidatesCount} candidats évalués • Sceau SHA-256 : ${escapeHtml((t.seal || '').substring(0, 16))}...
        </p>
        <div class="report-actions-bar">
          <a href="/api/arena/tournament/${encodeURIComponent(t.tournamentId)}/export?format=md" class="report-action-btn report-action-link" download>
            📄 Exporter Matrice Shortlist (.md)
          </a>
          <a href="/api/arena/tournament/${encodeURIComponent(t.tournamentId)}/export?format=json" class="report-action-btn" download>
            🧾 Export JSON Tournoi
          </a>
        </div>
      </div>
      <div class="report-kpis">
        <div class="kpi-item">
          <span class="kpi-label">SCORE PROFIL</span>
          <span class="kpi-val" style="font-size:1.35rem;">${t.champion?.profileScore ?? 0}/100</span>
        </div>
      </div>
    </div>

    <div class="diagnostic-grid" style="margin-bottom:1.5rem;">
      ${stagesHtml}
    </div>

    <div class="alternatives-section">
      <h3 style="font-size:1.05rem; color:#fff; margin-bottom:0.5rem;">📊 Matrice Comparative Complète (${t.candidatesCount} Dépôts)</h3>
      <table class="alt-table">
        <thead>
          <tr>
            <th>RANG</th><th>DÉPÔT</th><th>SCORE PROFIL</th><th>SCORE IA</th><th>LICENCE</th><th>CI /CD</th><th>BUS FACTOR</th><th>STATUT</th>
          </tr>
        </thead>
        <tbody>
          ${(t.ranking || []).map((c, idx) => `
            <tr>
              <td style="font-family:var(--font-mono); font-weight:bold;">#${idx + 1}</td>
              <td><span class="alt-link" onclick="inspectDirect('${escapeHtml(c.fullName)}')">${escapeHtml(c.fullName)}</span></td>
              <td style="color:var(--accent-cyan); font-weight:bold;">${c.profileScore}/100</td>
              <td>${c.aiScore}/100</td>
              <td style="color:${c.commercialSafe ? 'var(--accent-green)' : 'var(--accent-pink)'};">${escapeHtml(c.license)}</td>
              <td>${escapeHtml(c.ciStatus)}</td>
              <td>${escapeHtml(c.busFactorRisk)}</td>
              <td style="color:${c.eliminatedAtStage ? 'var(--accent-pink)' : 'var(--accent-green)'}; font-size:0.76rem;">
                ${c.eliminatedAtStage ? `✗ Éliminé (Ét. ${c.eliminatedAtStage})` : '✓ Survivant'}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function compareRepoInArena(fullName) {
  document.getElementById('arenaRepoAInput').value = fullName;
  document.getElementById('arenaRepoBInput').value = '';
  switchTab('arena');
  loadArenaDuel(true);
}

function compareTwoInArena(repoA, repoB) {
  document.getElementById('arenaRepoAInput').value = repoA;
  document.getElementById('arenaRepoBInput').value = repoB;
  switchTab('arena');
  loadArenaDuel(true);
}

async function loadArenaDuel(useInputs = false) {
  const container = document.getElementById('arenaContainer');
  if (!container) return;

  const params = new URLSearchParams();
  if (useInputs) {
    const a = document.getElementById('arenaRepoAInput')?.value.trim();
    const b = document.getElementById('arenaRepoBInput')?.value.trim();
    if (a && b) {
      params.set('a', a);
      params.set('b', b);
    }
  }

  try {
    const res = await fetch(`/api/arena/duel?${params.toString()}`);
    if (!res.ok) throw new Error('Erreur duel ' + res.status);
    const duel = await res.json();
    currentDuel = duel;
    renderArenaDuel(duel);
    loadArenaHistory();
  } catch (err) {
    container.innerHTML = `<div class="state-empty">Erreur lors du chargement du duel : ${escapeHtml(err.message)}</div>`;
  }
}

function renderArenaDuel(duel) {
  const container = document.getElementById('arenaContainer');
  const { repoA, repoB } = duel;

  const renderChallenger = (repo, side) => `
    <div class="arena-card">
      <div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <span class="badge-tag badge-jit">CHALLENGER ${side}</span>
          <span style="font-family:var(--font-mono); color:var(--accent-cyan); font-weight:700;">ELO ${repo.elo_rating}</span>
        </div>
        <h3 style="font-size:1.2rem; color:#fff; margin-bottom:0.35rem;">
          <span class="alt-link" onclick="inspectDirect('${escapeHtml(repo.full_name)}')">${escapeHtml(repo.full_name)}</span>
        </h3>
        <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:1rem;">${escapeHtml(repo.description || '')}</p>
        <ul class="diag-list">
          <li class="diag-item"><span class="diag-key">Score Potentiel IA :</span><span class="diag-val" style="color:var(--accent-green);">${repo.ai_potential_score}/100</span></li>
          <li class="diag-item"><span class="diag-key">Stars / Forks :</span><span class="diag-val">⭐ ${(repo.stars || 0).toLocaleString()} / ${(repo.forks || 0).toLocaleString()}</span></li>
          <li class="diag-item"><span class="diag-key">Langage :</span><span class="diag-val">${escapeHtml(repo.language)}</span></li>
          <li class="diag-item"><span class="diag-key">Licence :</span><span class="diag-val" style="color:${repo.commercialSafe ? 'var(--accent-green)' : 'var(--accent-amber)'};">${escapeHtml(repo.license)} ${repo.commercialSafe ? '✓' : '⚠'}</span></li>
          <li class="diag-item"><span class="diag-key">Fraîcheur :</span><span class="diag-val">il y a ${repo.daysSinceLastPush}j</span></li>
        </ul>
      </div>
      <button class="arena-vote-btn" onclick="castArenaVote('${side}')">
        🏆 Voter pour ${escapeHtml(repo.name)} (Challenger ${side})
      </button>
    </div>`;

  container.innerHTML = `
    <div style="margin-bottom:0.75rem; font-size:0.8rem; color:var(--text-dim); font-family:var(--font-mono);">
      CATÉGORIE : <strong style="color:#fff;">${escapeHtml(duel.category)}</strong>
    </div>
    <div class="arena-grid">
      ${renderChallenger(repoA, 'A')}
      <div class="arena-vs">
        <div>VS</div>
        <button class="quick-pill" style="margin-top:0.75rem;" onclick="castArenaVote('DRAW')">⚖️ Match Nul</button>
      </div>
      ${renderChallenger(repoB, 'B')}
    </div>
    <div id="arenaVoteResult" style="margin-top:1rem;"></div>`;
}

async function castArenaVote(winner) {
  if (!currentDuel) return;
  const resultBox = document.getElementById('arenaVoteResult');

  try {
    const res = await fetch('/api/arena/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoAId: currentDuel.repoA.id,
        repoBId: currentDuel.repoB.id,
        winner
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur vote');

    const fmtDelta = (d) => d >= 0 ? `+${d}` : `${d}`;
    resultBox.innerHTML = `
      <div class="report-header" style="border-color: var(--accent-green); padding: 1rem;">
        <div>
          <strong style="color: var(--accent-green);">✓ Arbitrage ELO scellé (Duel ${data.duelId.substring(0, 8)})</strong>
          <div style="font-size:0.85rem; color:var(--text-muted); margin-top:0.3rem; font-family:var(--font-mono);">
            ${escapeHtml(data.repoA.full_name)}: ${data.repoA.eloBefore} → <strong>${data.repoA.eloAfter}</strong> (${fmtDelta(data.repoA.delta)})
            &nbsp;|&nbsp;
            ${escapeHtml(data.repoB.full_name)}: ${data.repoB.eloBefore} → <strong>${data.repoB.eloAfter}</strong> (${fmtDelta(data.repoB.delta)})
          </div>
        </div>
        <button class="report-action-btn report-action-link" onclick="loadArenaDuel(false)">Duel Suivant ➔</button>
      </div>`;

    loadStats();
    loadArenaHistory();
  } catch (err) {
    resultBox.innerHTML = `<div style="color: var(--accent-pink);">Erreur : ${escapeHtml(err.message)}</div>`;
  }
}

async function loadArenaHistory() {
  const box = document.getElementById('arenaHistoryContainer');
  if (!box) return;
  try {
    const res = await fetch('/api/arena/history?limit=8');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.duels || data.duels.length === 0) {
      box.innerHTML = '<p style="font-size:0.8rem; color:var(--text-dim);">Aucun duel arbitré pour le moment. Votez ci-dessus !</p>';
      return;
    }
    box.innerHTML = `
      <table class="alt-table">
        <thead><tr><th>CHALLENGER A</th><th>ELO A</th><th>CHALLENGER B</th><th>ELO B</th><th>DATE</th></tr></thead>
        <tbody>
          ${data.duels.map(d => `
            <tr>
              <td>${escapeHtml(d.repo_a_name)}</td>
              <td style="font-family:var(--font-mono);">${d.repo_a_elo_before} → <strong>${d.repo_a_elo_after}</strong></td>
              <td>${escapeHtml(d.repo_b_name)}</td>
              <td style="font-family:var(--font-mono);">${d.repo_b_elo_before} → <strong>${d.repo_b_elo_after}</strong></td>
              <td style="color:var(--text-dim); font-size:0.75rem;">${escapeHtml(d.created_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  } catch { /* ignore */ }
}

/* ==================== RADAR GOD'S EYE ==================== */

function setRadarShader(mode) {
  currentRadarShader = mode;
  const wrap = document.getElementById('radarCanvasWrap');
  if (!wrap) return;
  wrap.classList.remove('shader-crt', 'shader-flir');
  if (mode === 'CRT') wrap.classList.add('shader-crt');
  if (mode === 'FLIR') wrap.classList.add('shader-flir');
}

async function loadRadarView() {
  const container = document.getElementById('radarSvgContainer');
  const layersBox = document.getElementById('radarLayersList');
  const sealBar = document.getElementById('radarSealBar');
  const cat = document.getElementById('radarCategorySelect')?.value || '';

  try {
    const params = new URLSearchParams({ limit: '90' });
    if (cat) params.set('category', cat);
    const res = await fetch(`/api/radar?${params.toString()}`);
    if (!res.ok) throw new Error('Erreur radar');
    const data = await res.json();

    const size = 460;
    const cx = size / 2;
    const cy = size / 2;
    const maxR = 195;

    const circles = [0.25, 0.5, 0.75, 1.0].map(f =>
      `<circle cx="${cx}" cy="${cy}" r="${Math.round(maxR * f)}" fill="none" stroke="rgba(0,243,255,0.16)" stroke-dasharray="3,4"/>`
    ).join('');

    const nodesSvg = (data.nodes || []).map(n => {
      const px = Math.round(cx + n.coords.x * maxR);
      const py = Math.round(cy + n.coords.y * maxR);
      const r = n.status === 'ELITE_TARGET' ? 5.5 : 3.8;
      return `<circle cx="${px}" cy="${py}" r="${r}" fill="${n.color}" stroke="#000" stroke-width="1" style="cursor:pointer;" onclick="inspectDirect('${escapeHtml(n.fullName)}')">
        <title>${escapeHtml(n.fullName)} • ELO ${n.elo} • Score ${n.aiScore}/100 (${escapeHtml(n.layer)})</title>
      </circle>`;
    }).join('');

    container.innerHTML = `
      <svg viewBox="0 0 ${size} ${size}" style="width:100%; max-width:460px; height:auto;">
        ${circles}
        <line x1="${cx}" y1="15" x2="${cx}" y2="${size - 15}" stroke="rgba(0,243,255,0.15)"/>
        <line x1="15" y1="${cy}" x2="${size - 15}" y2="${cy}" stroke="rgba(0,243,255,0.15)"/>
        <circle cx="${cx}" cy="${cy}" r="3" fill="#00ff88"/>
        ${nodesSvg}
      </svg>`;

    if (sealBar) {
      sealBar.textContent = `${data.radarVersion} • ${data.totalTargets} cibles • Sceau SHA-256 : ${data.integritySeal.substring(0, 24)}...`;
    }

    if (layersBox) {
      const layerEntries = Object.entries(data.layers || {}).sort((a, b) => b[1] - a[1]);
      const topNodes = (data.nodes || []).slice(0, 8);
      layersBox.innerHTML = `
        <div style="margin-bottom:0.85rem;">
          <div style="font-size:0.75rem; color:var(--text-dim); margin-bottom:0.4rem;">Grappes actives :</div>
          <div style="display:flex; flex-wrap:wrap; gap:0.35rem;">
            ${layerEntries.map(([tag, cnt]) => `<span class="dep-tag">${escapeHtml(tag)} (${cnt})</span>`).join('')}
          </div>
        </div>
        <div style="font-size:0.75rem; color:var(--text-dim); margin-bottom:0.4rem;">Cibles haute priorité (cliquer pour inspecter) :</div>
        <ul class="diag-list">
          ${topNodes.map(n => `
            <li class="diag-item" style="cursor:pointer;" onclick="inspectDirect('${escapeHtml(n.fullName)}')">
              <span style="color:${n.color};">● ${escapeHtml(n.fullName)}</span>
              <span class="diag-val">ELO ${n.elo}</span>
            </li>
          `).join('')}
        </ul>`;
    }
  } catch (err) {
    container.innerHTML = `<p style="color:var(--accent-pink);">Erreur radar : ${escapeHtml(err.message)}</p>`;
  }
}

/* ==================== COPIES & UTILITAIRES ==================== */

function copyQuickstart() {
  if (!currentInspectedRepo || !currentInspectedRepo.health) return;
  const cmds = currentInspectedRepo.health.quickstart.join('\n');
  navigator.clipboard.writeText(cmds).then(() => alert('Commandes copiées !')).catch(() => prompt('Copiez :', cmds));
}

function copyBadgeMarkdown(fullName) {
  const badgeUrl = `${window.location.origin}/api/badge/${fullName}`;
  const md = `[![RepoVerify Checked](${badgeUrl})](https://github.com/${fullName})`;
  navigator.clipboard.writeText(md).then(() => alert(`Badge copié :\n\n${md}`)).catch(() => prompt('Copiez :', md));
}

function copyFullReport() {
  if (!currentInspectedRepo) return;
  const { repository: repo, health, legalAndSecurity: legal } = currentInspectedRepo;
  const ci = window._lastCodeIntel;

  const lines = [
    `REPOVERIFY — Rapport d'Inspection : ${repo.full_name}`,
    `Score IA : ${repo.ai_potential_score}/100 | ELO : ${repo.elo_rating} | Stars : ${(repo.stars || 0).toLocaleString()}`,
    `Santé : ${health.status} | Fiabilité : ${health.environment.passRate} | Dernier commit : il y a ${health.daysSinceLastPush}j`,
    `Licence : ${legal.licenseSpdx} | Commercial Safe : ${legal.commercialSafe ? 'OUI' : 'NON'}`,
    ci && ci.available ? `Maturité : ${ci.maturityScore}/100 | CVE OSV : ${ci.vulnerabilities?.totalVulnerabilities ?? 'N/A'}` : ''
  ].filter(Boolean);

  const report = lines.join('\n');
  navigator.clipboard.writeText(report).then(() => alert('Rapport copié !')).catch(() => prompt('Copiez :', report));
}

function copyCiSummary() {
  const ci = window._lastCodeIntel;
  if (!ci) return;
  const summary = `Repo: ${ci._repoName}\nFiles: ${ci.filesAnalyzed}\nTokens: ${ci.estimatedTokens}\nMaturity: ${ci.maturityScore}/100`;
  navigator.clipboard.writeText(summary).then(() => alert('Résumé copié !')).catch(() => prompt('Copiez :', summary));
}

function copyCiTree() {
  const el = document.getElementById('ciTreeContent');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => alert('Arbre copié !')).catch(() => prompt('Copiez :', el.textContent.substring(0, 2000)));
}

async function triggerSandboxVerification(fullName) {
  const box = document.getElementById('sandboxResultBox');
  if (!box) return;
  box.innerHTML = `<div style="padding:0.65rem; background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:4px; font-size:0.78rem; color:var(--text-muted);">🧪 Exécution Sandbox Docker (--network=none) pour <strong>${escapeHtml(fullName)}</strong> en cours...</div>`;

  try {
    const res = await fetch('/api/sandbox/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: fullName })
    });
    const data = await res.json();

    if (data.status === 'DOCKER_REQUIRED') {
      box.innerHTML = `
        <div style="padding:0.75rem; background:var(--accent-amber-bg); border:1px solid rgba(245,158,11,0.35); border-radius:4px; font-size:0.78rem;">
          <strong style="color:var(--accent-amber);">⚠ Docker Daemon requis pour l'isolation Zero-Egress</strong>
          <p style="color:var(--text-muted); margin:0.35rem 0;">${escapeHtml(data.message)}</p>
          <code style="display:block; background:#090a0d; padding:0.45rem; border-radius:4px; color:var(--accent-cyan); overflow-x:auto;">${escapeHtml(data.recommendedCommand)}</code>
        </div>`;
      return;
    }

    const color = data.ok ? 'var(--accent-green)' : 'var(--accent-pink)';
    box.innerHTML = `
      <div style="padding:0.75rem; background:var(--bg-elevated); border:1px solid ${color}; border-radius:4px; font-size:0.78rem;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="color:${color};">${data.ok ? '✓ Sandbox Exit Code 0 Confirmé' : `✗ Échec Sandbox (Exit ${data.exitCode})`}</strong>
          <span style="font-family:var(--font-mono); color:var(--text-dim);">${data.durationMs || 0} ms • ${escapeHtml(data.image || '')}</span>
        </div>
        ${data.receiptHash ? `<div style="font-family:var(--font-mono); font-size:0.7rem; color:var(--text-dim); margin-top:0.25rem;">Receipt SHA-256 : ${escapeHtml(data.receiptHash)}</div>` : ''}
        ${data.stdout || data.stderr ? `<pre style="margin-top:0.45rem; background:#090a0d; padding:0.5rem; max-height:140px; overflow:auto; font-size:0.7rem; color:var(--text-muted);">${escapeHtml((data.stdout || '') + '\n' + (data.stderr || ''))}</pre>` : ''}
      </div>`;
  } catch (err) {
    box.innerHTML = `<div style="color:var(--accent-pink); font-size:0.78rem;">Erreur Sandbox : ${escapeHtml(err.message)}</div>`;
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
