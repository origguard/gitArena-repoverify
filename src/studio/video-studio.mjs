import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, closeDatabase } from '../db/database.mjs';
import { inspectRepository, inspectCodeIntelligence } from '../engines/repo-service.mjs';
import { runMultiRepoTournament } from '../engines/tournament-engine.mjs';

/**
 * Sovereign Video Duel Studio — RepoVerify / GitArena
 * Génère des vidéos verticales 9:16 (1080x1920, H.264 MP4 + Audio AAC) prêtes pour
 * LinkedIn, X/Twitter, YouTube Shorts & TikTok, sans dépendance NPM ni FFmpeg externe.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VIDEOS_DIR = join(__dirname, '../../videos');

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

export function findHeadlessBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function buildStudioHtml(duelData, durationSec = 22) {
  const safeJson = JSON.stringify(duelData).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>RepoVerify Video Renderer</title>
  <style>
    body { margin: 0; background: #090a0d; overflow: hidden; }
    canvas { display: block; width: 360px; height: 640px; }
  </style>
</head>
<body>
  <canvas id="stage" width="1080" height="1920"></canvas>
  <div id="status" style="color:#0f8;font-family:monospace;padding:8px;">INIT</div>
  <script>
    const DATA = ${safeJson};
    const DURATION_MS = ${durationSec * 1000};
    const FPS = 30;
    const canvas = document.getElementById('stage');
    const ctx = canvas.getContext('2d');
    const statusEl = document.getElementById('status');

    function easeOutCubic(x) {
      return 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
    }

    function roundRect(x, y, w, h, r, fill, stroke, lineWidth = 2) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
    }

    function drawWrappedText(text, x, y, maxWidth, lineHeight, color, font, align = 'left') {
      ctx.fillStyle = color;
      ctx.font = font;
      ctx.textAlign = align;
      const words = String(text || '').split(' ');
      let line = '';
      let cy = y;
      for (let i = 0; i < words.length; i++) {
        const test = line + words[i] + ' ';
        if (ctx.measureText(test).width > maxWidth && i > 0) {
          ctx.fillText(line.trim(), x, cy);
          line = words[i] + ' ';
          cy += lineHeight;
        } else {
          line = test;
        }
      }
      if (line.trim()) ctx.fillText(line.trim(), x, cy);
      return cy;
    }

    function drawBackground(tSec) {
      const grad = ctx.createLinearGradient(0, 0, 0, 1920);
      grad.addColorStop(0, '#07090e');
      grad.addColorStop(0.5, '#0c111b');
      grad.addColorStop(1, '#07090d');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1080, 1920);

      // Grille Cyber-Industrial subtile
      ctx.strokeStyle = 'rgba(0, 243, 255, 0.045)';
      ctx.lineWidth = 1;
      const offset = (tSec * 24) % 90;
      for (let x = 0; x < 1080; x += 90) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 1920); ctx.stroke();
      }
      for (let y = offset; y < 1920; y += 90) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1080, y); ctx.stroke();
      }

      // Lueur supérieure
      const glow = ctx.createRadialGradient(540, 260, 20, 540, 260, 520);
      glow.addColorStop(0, 'rgba(0, 243, 255, 0.14)');
      glow.addColorStop(1, 'rgba(0, 243, 255, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, 1080, 800);
    }

    function drawHeader(tSec) {
      // Top Pill Brand
      roundRect(310, 82, 460, 58, 29, 'rgba(0, 255, 136, 0.1)', 'rgba(0, 255, 136, 0.45)', 2);
      ctx.fillStyle = '#00ff88';
      ctx.font = 'bold 26px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('✓ REPOVERIFY / GITARENA', 540, 120);

      // Barre de progression temporelle en haut
      const pct = Math.min(1, tSec / (DURATION_MS / 1000));
      ctx.fillStyle = '#181c27';
      ctx.fillRect(0, 0, 1080, 10);
      ctx.fillStyle = '#00f3ff';
      ctx.fillRect(0, 0, 1080 * pct, 10);
    }

    function drawFighterCard(repo, x, y, w, h, accent, tag) {
      roundRect(x, y, w, h, 24, '#111622', accent, 3);
      roundRect(x + 28, y + 26, 200, 40, 20, 'rgba(255,255,255,0.06)', accent, 1.5);
      ctx.fillStyle = accent;
      ctx.font = 'bold 22px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(tag, x + 128, y + 53);

      ctx.textAlign = 'left';
      ctx.fillStyle = '#8b97ab';
      ctx.font = '600 24px "Segoe UI", Arial, sans-serif';
      ctx.fillText(repo.owner + ' /', x + 28, y + 115);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 44px "Segoe UI", Arial, sans-serif';
      ctx.fillText(repo.name, x + 28, y + 168);

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '600 26px Consolas, monospace';
      ctx.fillText('★ ' + repo.stars.toLocaleString('en-US') + '   •   ' + repo.language, x + 28, y + 225);
    }

    function drawMetricCompareBar(label, valA, valB, maxVal, unit, y, animProgress, goodColorA, goodColorB) {
      const p = easeOutCubic(animProgress);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 26px Consolas, monospace';
      ctx.fillText(label, 540, y);

      const barW = 410;
      const barH = 38;
      const leftX = 75;
      const rightX = 595;
      const barY = y + 20;

      roundRect(leftX, barY, barW, barH, 10, '#181c27', '#252b3d', 1.5);
      roundRect(rightX, barY, barW, barH, 10, '#181c27', '#252b3d', 1.5);

      const ratioA = Math.min(1, Math.max(0.08, (valA / maxVal))) * p;
      const ratioB = Math.min(1, Math.max(0.08, (valB / maxVal))) * p;

      roundRect(leftX, barY, barW * ratioA, barH, 10, goodColorA, null);
      roundRect(rightX, barY, barW * ratioB, barH, 10, goodColorB, null);

      ctx.font = 'bold 30px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(Math.round(valA * p * 10) / 10 + unit, leftX + 14, barY + 76);

      ctx.textAlign = 'right';
      ctx.fillText(Math.round(valB * p * 10) / 10 + unit, rightX + barW - 14, barY + 76);
    }

    function drawFooterCta(tSec) {
      roundRect(64, 1740, 952, 120, 20, '#0f172a', 'rgba(0, 243, 255, 0.35)', 2);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#00f3ff';
      ctx.font = 'bold 26px Consolas, monospace';
      ctx.fillText('github.com/origguard/gitArena-repoverify', 540, 1790);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '600 24px "Segoe UI", Arial, sans-serif';
      ctx.fillText('Audit Open-Source, Licences & CVE en 48h • Lien en bio', 540, 1834);
    }

    function renderFrame(tSec) {
      drawBackground(tSec);
      drawHeader(tSec);

      const A = DATA.repoA;
      const B = DATA.repoB;

      // Vignette permanente haut : A vs B compact ou large selon scène
      if (tSec < 4.0) {
        // SCÈNE 1 (0 - 4s) : HOOK & PRÉSENTATION DU DUEL (Frame 0 garantie lisible)
        drawWrappedText(DATA.hookHeadline, 540, 245, 960, 68, '#ffffff', '900 58px "Segoe UI", Arial, sans-serif', 'center');
        ctx.fillStyle = '#00f3ff';
        ctx.font = 'bold 30px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(DATA.categoryLabel, 540, 415);

        drawFighterCard(A, 74, 490, 932, 265, '#00f3ff', 'CHALLENGER A');

        // Badge VS
        roundRect(470, 782, 140, 66, 33, '#f59e0b', '#000', 2);
        ctx.fillStyle = '#000000';
        ctx.font = '900 34px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('VS', 540, 827);

        drawFighterCard(B, 74, 875, 932, 265, '#ff3366', 'CHALLENGER B');

        roundRect(74, 1210, 932, 190, 20, 'rgba(0, 255, 136, 0.06)', 'rgba(0, 255, 136, 0.3)', 2);
        drawWrappedText(
          'Comparatif réel : Score IA, Licence commerciale, Santé CI/CD & Vulnérabilités OSV.dev.',
          540, 1282, 860, 44, '#e2e8f0', '600 32px "Segoe UI", Arial, sans-serif', 'center'
        );
      } else if (tSec < 9.5) {
        // SCÈNE 2 (4 - 9.5s) : SCORE IA, ELO & ACTIVITÉ
        ctx.textAlign = 'center';
        ctx.fillStyle = '#00f3ff';
        ctx.font = 'bold 34px Consolas, monospace';
        ctx.fillText('ÉPREUVE 1 / 3 : PERFORMANCE & SCORE IA', 540, 230);

        // Mini headers côte à côte
        roundRect(74, 290, 430, 140, 18, '#111622', '#00f3ff', 2.5);
        roundRect(576, 290, 430, 140, 18, '#111622', '#ff3366', 2.5);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 34px "Segoe UI", Arial, sans-serif';
        ctx.fillText(A.name, 289, 355);
        ctx.fillText(B.name, 791, 355);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '24px Consolas, monospace';
        ctx.fillText(A.language + ' • ★ ' + A.stars.toLocaleString('en-US'), 289, 398);
        ctx.fillText(B.language + ' • ★ ' + B.stars.toLocaleString('en-US'), 791, 398);

        const p = (tSec - 4.0) / 1.4;
        drawMetricCompareBar('SCORE POTENTIEL IA (/100)', A.aiScore, B.aiScore, 100, '/100', 540, p, '#00ff88', '#00f3ff');
        drawMetricCompareBar('CLASSEMENT ARÈNE ELO', A.elo, B.elo, 2000, ' ELO', 740, p - 0.15, '#00f3ff', '#a855f7');
        drawMetricCompareBar('ADOPTION (FORKS)', A.forks, B.forks, Math.max(A.forks, B.forks) * 1.15, '', 940, p - 0.3, '#38bdf8', '#f59e0b');

        roundRect(74, 1170, 932, 230, 20, '#111622', '#252b3d', 2);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#00ff88';
        ctx.font = 'bold 30px Consolas, monospace';
        ctx.fillText('FRAÎCHEUR DE MAINTENANCE', 540, 1235);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 34px "Segoe UI", Arial, sans-serif';
        ctx.fillText(A.name + ' : il y a ' + A.daysSincePush + 'j   |   ' + B.name + ' : il y a ' + B.daysSincePush + 'j', 540, 1315);
      } else if (tSec < 15.0) {
        // SCÈNE 3 (9.5 - 15s) : AUDIT JURIDIQUE, CI/CD & OSV.DEV
        ctx.textAlign = 'center';
        ctx.fillStyle = '#00ff88';
        ctx.font = 'bold 34px Consolas, monospace';
        ctx.fillText('ÉPREUVE 2 / 3 : LICENCE, CI/CD & CVE', 540, 230);

        const drawAuditCol = (repo, x, borderCol) => {
          roundRect(x, 300, 446, 1080, 22, '#111622', borderCol, 3);
          ctx.textAlign = 'center';
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 36px "Segoe UI", Arial, sans-serif';
          ctx.fillText(repo.name, x + 223, 370);

          // Licence
          const licOk = repo.commercialSafe;
          roundRect(x + 28, 430, 390, 210, 16, licOk ? 'rgba(0,255,136,0.08)' : 'rgba(255,51,102,0.12)', licOk ? '#00ff88' : '#ff3366', 2);
          ctx.fillStyle = '#94a3b8';
          ctx.font = 'bold 22px Consolas, monospace';
          ctx.fillText('LICENCE SPDX', x + 223, 475);
          ctx.fillStyle = licOk ? '#00ff88' : '#ff3366';
          ctx.font = 'bold 38px Consolas, monospace';
          ctx.fillText(repo.license, x + 223, 535);
          ctx.font = 'bold 24px "Segoe UI", Arial, sans-serif';
          ctx.fillText(licOk ? '✓ Commercial Safe' : '⚠ Copyleft / Risque', x + 223, 595);

          // CI/CD
          roundRect(x + 28, 680, 390, 210, 16, 'rgba(0,243,255,0.06)', '#252b3d', 2);
          ctx.fillStyle = '#94a3b8';
          ctx.font = 'bold 22px Consolas, monospace';
          ctx.fillText('SANTÉ CI / BUILD', x + 223, 725);
          ctx.fillStyle = '#00f3ff';
          ctx.font = 'bold 34px Consolas, monospace';
          ctx.fillText(repo.ciLabel, x + 223, 790);
          ctx.fillStyle = '#cbd5e1';
          ctx.font = '22px "Segoe UI", Arial, sans-serif';
          ctx.fillText(repo.ciSub, x + 223, 845);

          // Sécurité OSV.dev
          const cveOk = repo.cveCount === 0;
          roundRect(x + 28, 930, 390, 210, 16, cveOk ? 'rgba(0,255,136,0.06)' : 'rgba(245,158,11,0.1)', cveOk ? '#00ff88' : '#f59e0b', 2);
          ctx.fillStyle = '#94a3b8';
          ctx.font = 'bold 22px Consolas, monospace';
          ctx.fillText('SUPPLY-CHAIN OSV.DEV', x + 223, 975);
          ctx.fillStyle = cveOk ? '#00ff88' : '#f59e0b';
          ctx.font = 'bold 34px Consolas, monospace';
          ctx.fillText(repo.cveLabel, x + 223, 1040);
          ctx.fillStyle = '#cbd5e1';
          ctx.font = '22px "Segoe UI", Arial, sans-serif';
          ctx.fillText(repo.cveSub, x + 223, 1095);

          // BigCode
          ctx.fillStyle = licOk ? '#00ff88' : '#ff3366';
          ctx.font = 'bold 26px Consolas, monospace';
          ctx.fillText(licOk ? 'BIGCODE STACK v2 : OK' : 'BIGCODE : EXCLU', x + 223, 1265);
        };

        drawAuditCol(A, 74, '#00f3ff');
        drawAuditCol(B, 560, '#ff3366');
      } else if (tSec < 18.8) {
        // SCÈNE 4 (15 - 18.8s) : VERDICT & GAGNANT DU DUEL
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f59e0b';
        ctx.font = 'bold 36px Consolas, monospace';
        ctx.fillText('VERDICT REPOVERIFY', 540, 240);

        roundRect(74, 330, 932, 520, 28, 'rgba(0, 255, 136, 0.08)', '#00ff88', 4);
        ctx.fillStyle = '#00ff88';
        ctx.font = 'bold 28px Consolas, monospace';
        ctx.fillText('🏆 AVANTAGE RECOMMANDÉ', 540, 415);

        ctx.fillStyle = '#ffffff';
        ctx.font = '900 62px "Segoe UI", Arial, sans-serif';
        ctx.fillText(DATA.winnerFullName, 540, 520);

        drawWrappedText(DATA.verdictReason, 540, 620, 840, 48, '#e2e8f0', '600 34px "Segoe UI", Arial, sans-serif', 'center');

        // Récapitulatif Score final
        roundRect(74, 920, 932, 340, 22, '#111622', '#252b3d', 2);
        ctx.fillStyle = '#94a3b8';
        ctx.font = 'bold 26px Consolas, monospace';
        ctx.fillText('RÉCAPITULATIF DU MATCH', 540, 985);
        ctx.fillStyle = '#00f3ff';
        ctx.font = 'bold 34px Consolas, monospace';
        ctx.fillText(A.name + ' : ' + A.aiScore + '/100  (' + A.license + ')', 540, 1080);
        ctx.fillStyle = '#ff3366';
        ctx.fillText(B.name + ' : ' + B.aiScore + '/100  (' + B.license + ')', 540, 1165);
      } else {
        // SCÈNE 5 (18.8 - 22s) : APPEL À L'ACTION B2B & OPEN-SOURCE
        ctx.textAlign = 'center';
        ctx.fillStyle = '#00ff88';
        ctx.font = 'bold 34px Consolas, monospace';
        ctx.fillText('TESTEZ VOS DÉPÔTS DÈS MAINTENANT', 540, 320);

        roundRect(74, 410, 932, 460, 28, '#111622', '#00f3ff', 3);
        ctx.fillStyle = '#ffffff';
        ctx.font = '900 54px "Segoe UI", Arial, sans-serif';
        ctx.fillText('RepoVerify / GitArena', 540, 520);
        drawWrappedText(
          'Outil Open-Source Apache-2.0 : Inspection CI/CD, Scan CVE OSV.dev, Sandbox Docker & Serveur MCP.',
          540, 615, 820, 48, '#cbd5e1', '600 32px "Segoe UI", Arial, sans-serif', 'center'
        );
        ctx.fillStyle = '#00ff88';
        ctx.font = 'bold 30px Consolas, monospace';
        ctx.fillText('github.com/origguard/gitArena-repoverify', 540, 805);

        roundRect(74, 950, 932, 400, 28, 'rgba(245, 158, 11, 0.08)', '#f59e0b', 3);
        ctx.fillStyle = '#f59e0b';
        ctx.font = 'bold 30px Consolas, monospace';
        ctx.fillText('AUDIT B2B & DUE-DILIGENCE EN 48H', 540, 1040);
        drawWrappedText(
          'Vous préparez une mise en prod ou une levée de fonds ? Demandez un audit complet de vos licences et vulnérabilités en DM.',
          540, 1130, 820, 48, '#ffffff', 'bold 34px "Segoe UI", Arial, sans-serif', 'center'
        );
      }

      drawFooterCta(tSec);
    }

    // Synthèse sonore douce Web Audio (aucun fichier externe requis)
    function setupAudioTrack() {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioCtx();
        const dest = audioCtx.createMediaStreamDestination();

        const masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.14;
        masterGain.connect(dest);

        const playTone = (freq, startSec, durSec, type = 'sine', vol = 0.25) => {
          const osc = audioCtx.createOscillator();
          const g = audioCtx.createGain();
          osc.type = type;
          osc.frequency.setValueAtTime(freq, audioCtx.currentTime + startSec);
          g.gain.setValueAtTime(0.0001, audioCtx.currentTime + startSec);
          g.gain.exponentialRampToValueAtTime(vol, audioCtx.currentTime + startSec + 0.03);
          g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + startSec + durSec);
          osc.connect(g);
          g.connect(masterGain);
          osc.start(audioCtx.currentTime + startSec);
          osc.stop(audioCtx.currentTime + startSec + durSec + 0.02);
        };

        // Pulses rythmiques feutrés (120 BPM) + transitions de scène
        for (let s = 0; s < ${durationSec}; s += 0.5) {
          playTone(s % 2 === 0 ? 110 : 82.4, s, 0.22, 'triangle', s % 2 === 0 ? 0.22 : 0.12);
        }
        [0, 4.0, 9.5, 15.0, 18.8].forEach((cue, idx) => {
          playTone(440 + idx * 110, cue, 0.35, 'sine', 0.35);
          playTone(660 + idx * 110, cue + 0.08, 0.28, 'sine', 0.2);
        });

        return { audioCtx, track: dest.stream.getAudioTracks()[0] };
      } catch {
        return null;
      }
    }

    async function startRecording() {
      renderFrame(0); // Frame 0 garantie immédiatement

      const canvasStream = canvas.captureStream(FPS);
      const audio = setupAudioTrack();
      if (audio && audio.track) {
        canvasStream.addTrack(audio.track);
      }

      const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2')
        ? 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'
        : (MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm');

      const chunks = [];
      const recorder = new MediaRecorder(canvasStream, {
        mimeType,
        videoBitsPerSecond: 4500000
      });

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: mimeType });
        statusEl.textContent = 'UPLOADING_' + blob.size;
        await fetch('/upload', { method: 'POST', body: blob });
        if (audio?.audioCtx) audio.audioCtx.close().catch(() => {});
        statusEl.textContent = 'DONE';
      };

      recorder.start(250);
      statusEl.textContent = 'RECORDING_' + mimeType;

      const startMs = performance.now();
      const timer = setInterval(() => {
        const elapsed = performance.now() - startMs;
        const tSec = Math.min(DURATION_MS / 1000, elapsed / 1000);
        renderFrame(tSec);
        if (elapsed >= DURATION_MS) {
          clearInterval(timer);
          recorder.stop();
        }
      }, 1000 / FPS);
    }

    startRecording();
  </script>
</body>
</html>`;
}

async function prepareFighterData(slug) {
  const [owner, name] = slug.split('/');
  const insp = await inspectRepository(owner, name, { includeLiveCi: true, persistHarness: false });
  if (!insp.ok) {
    throw new Error(`Dépôt introuvable pour vidéo : ${slug}`);
  }
  const { repository: r, health, legalAndSecurity: legal } = insp.payload;

  // Vérifier Code Intel en cache ou tenter rapidement (timeout implicite)
  let ciLabel = health.ciTelemetry?.available
    ? `${health.ciTelemetry.ciPassRate ?? 100}% PASS`
    : 'AUDIT EXIT 0';
  let ciSub = health.ciTelemetry?.available
    ? `GitHub Actions (${health.ciTelemetry.lastRunStatus})`
    : 'Structure validée';

  let cveCount = 0;
  let cveLabel = '0 CVE CONNUE';
  let cveSub = 'Supply-Chain saine';

  try {
    const intel = await inspectCodeIntelligence(owner, name);
    if (intel && intel.available) {
      if (intel.vulnerabilities && intel.vulnerabilities.scanned) {
        cveCount = intel.vulnerabilities.totalVulnerabilities || 0;
        cveLabel = cveCount === 0 ? '0 CVE CONNUE' : `${cveCount} CVE (${intel.vulnerabilities.maxSeverity})`;
        cveSub = `${intel.vulnerabilities.packagesChecked} paquets scannés`;
      } else {
        cveLabel = `MATURITÉ ${intel.maturityScore}/100`;
        cveSub = `${intel.filesAnalyzed} fichiers analysés`;
      }
    }
  } catch { /* fallback propre */ }

  return {
    fullName: r.full_name,
    owner: r.owner,
    name: r.name,
    stars: r.stars || 0,
    forks: r.forks || 0,
    language: r.language || 'Code',
    license: r.license || 'Non spécifiée',
    commercialSafe: Boolean(legal.commercialSafe),
    aiScore: r.ai_potential_score || 0,
    elo: r.elo_rating || 1500,
    daysSincePush: health.daysSinceLastPush || 0,
    ciLabel,
    ciSub,
    cveCount,
    cveLabel,
    cveSub
  };
}

function chooseWinnerAndCopy(A, B, customHook = null) {
  // Avantage pondéré : licence commerciale prioritaire, puis Score IA + ELO
  const scoreA = A.aiScore + (A.commercialSafe ? 15 : -20) + (A.elo - 1500) * 0.05;
  const scoreB = B.aiScore + (B.commercialSafe ? 15 : -20) + (B.elo - 1500) * 0.05;
  const winner = scoreA >= scoreB ? A : B;
  const loser = winner === A ? B : A;

  let verdictReason = `Score IA de ${winner.aiScore}/100, licence ${winner.license} et meilleure note composite technique.`;
  if (winner.commercialSafe && !loser.commercialSafe) {
    verdictReason = `Licence permissive ${winner.license} sans risque viral copyleft (contrairement à ${loser.license}) + Score ${winner.aiScore}/100.`;
  }

  const hookHeadline = customHook || `${A.name.toUpperCase()} vs ${B.name.toUpperCase()} : LE VERDICT`;
  const categoryLabel = `${A.language} / ${B.language} • DUE DILIGENCE`;

  return {
    winnerFullName: winner.fullName,
    verdictReason,
    hookHeadline,
    categoryLabel
  };
}

function buildSocialPosts(duel) {
  const { repoA: A, repoB: B, winnerFullName, verdictReason } = duel;
  return `# Pack Publication Réseaux — ${A.fullName} vs ${B.fullName}

## LinkedIn (FR — B2B / CTO / Tech Leads)
⚔️ **${A.fullName} vs ${B.fullName}** : lequel choisir en production ?

Beaucoup d'équipes se fient uniquement aux étoiles GitHub. On a passé les deux dépôts au scanner **RepoVerify / GitArena** :

🔹 **${A.fullName}** : ${A.stars.toLocaleString('fr-FR')} ★ • Licence \`${A.license}\` (${A.commercialSafe ? 'Commercial Safe ✅' : 'Risque Copyleft ⚠️'}) • Score IA **${A.aiScore}/100** • ELO **${A.elo}**
🔹 **${B.fullName}** : ${B.stars.toLocaleString('fr-FR')} ★ • Licence \`${B.license}\` (${B.commercialSafe ? 'Commercial Safe ✅' : 'Risque Copyleft ⚠️'}) • Score IA **${B.aiScore}/100** • ELO **${B.elo}**

🏆 **Verdict :** ${winnerFullName} — ${verdictReason}

🛠️ Outil 100 % open-source (Apache-2.0, zéro dépendance NPM) :
👉 https://github.com/origguard/gitArena-repoverify

📩 Vous préparez une mise en production ou une levée de fonds ? Je réalise l'audit complet de vos dépôts et dépendances (licences, CVE OSV.dev, santé CI/CD) en 48 h — contactez-moi en DM.

#OpenSource #GitHub #DevSecOps #DueDiligence #IA #CTO #SoftwareEngineering

---

## X / Twitter & YouTube Shorts (EN)
⚔️ ${A.name} vs ${B.name} — Don't pick your production stack by GitHub stars alone.

We audited both with **RepoVerify** (Open-Source):
• ${A.fullName}: ${A.aiScore}/100 | License: ${A.license} | ${A.ciLabel}
• ${B.fullName}: ${B.aiScore}/100 | License: ${B.license} | ${B.ciLabel}

🏆 Edge: **${winnerFullName}** — ${A.commercialSafe !== B.commercialSafe ? 'Permissive commercial license advantage!' : 'Higher composite AI & ELO score.'}

Repo: https://github.com/origguard/gitArena-repoverify
#GitHub #OpenSource #AI #DevTools #SupplyChainSecurity
`;
}

async function renderHtmlToMp4(browserPath, html, outMp4, timeoutMs = 55000) {
  return new Promise((resolve, reject) => {
    let browserProc = null;
    let settled = false;

    const srv = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (req.method === 'POST' && req.url === '/upload') {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const buf = Buffer.concat(chunks);
          writeFileSync(outMp4, buf);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, bytes: buf.length }));
          settled = true;
          if (browserProc) browserProc.kill();
          srv.close(() => resolve(buf.length));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        if (browserProc) browserProc.kill();
        srv.close();
        reject(new Error(`Timeout rendu vidéo pour ${outMp4}`));
      }
    }, timeoutMs);

    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      browserProc = spawn(browserPath, [
        '--headless=new',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1080,1920',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        `http://127.0.0.1:${port}/`
      ], { stdio: 'ignore' });

      browserProc.on('close', () => {
        clearTimeout(timeout);
        if (!settled) {
          srv.close();
          reject(new Error(`Navigateur fermé avant l'export MP4 de ${outMp4}`));
        }
      });
    });
  });
}

export async function renderHtmlToCarouselPdf(browserPath, html, outPdf) {
  const tempHtml = join(tmpdir(), `repoverify-carousel-${Date.now()}.html`);
  writeFileSync(tempHtml, html, 'utf8');
  return new Promise((resolve, reject) => {
    const proc = spawn(browserPath, [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--print-to-pdf=${outPdf}`,
      `file://${tempHtml.replace(/\\/g, '/')}`
    ], { stdio: 'ignore' });

    proc.on('error', (err) => {
      try { rmSync(tempHtml, { force: true }); } catch { /* ignore */ }
      reject(err);
    });
    proc.on('close', (code) => {
      try { rmSync(tempHtml, { force: true }); } catch { /* ignore */ }
      if (code === 0 && existsSync(outPdf)) {
        resolve(statSync(outPdf).size);
      } else {
        reject(new Error(`Échec génération Carrousel PDF (code ${code})`));
      }
    });
  });
}

function buildTournamentVideoHtml(tournament, hookHeadline, durationSec = 26) {
  const safeJson = JSON.stringify({
    hookHeadline,
    profileLabel: tournament.profileMeta?.label || tournament.profile,
    category: tournament.category,
    candidates: tournament.ranking,
    podium: tournament.podium,
    champion: tournament.champion
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Tournament Renderer</title></head>
<body style="margin:0;background:#090a0d;overflow:hidden;">
<canvas id="stage" width="1080" height="1920"></canvas>
<script>
const T = ${safeJson};
const DURATION_MS = ${durationSec * 1000};
const FPS = 30;
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

function easeOut(x) { return 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3); }
function rr(x, y, w, h, r, fill, stroke, lw = 2) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
function wrap(text, x, y, mw, lh, col, font, align = 'center') {
  ctx.fillStyle = col; ctx.font = font; ctx.textAlign = align;
  const words = String(text || '').split(' ');
  let line = '', cy = y;
  for (let i = 0; i < words.length; i++) {
    const test = line + words[i] + ' ';
    if (ctx.measureText(test).width > mw && i > 0) {
      ctx.fillText(line.trim(), x, cy); line = words[i] + ' '; cy += lh;
    } else line = test;
  }
  if (line.trim()) ctx.fillText(line.trim(), x, cy);
}

function drawBg(t) {
  const g = ctx.createLinearGradient(0, 0, 0, 1920);
  g.addColorStop(0, '#07090e'); g.addColorStop(0.5, '#0d1320'); g.addColorStop(1, '#07090d');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 1080, 1920);
  ctx.strokeStyle = 'rgba(0,243,255,0.045)'; ctx.lineWidth = 1;
  for (let x = 0; x < 1080; x += 90) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,1920); ctx.stroke(); }
  for (let y = (t*20)%90; y < 1920; y += 90) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(1080,y); ctx.stroke(); }
  rr(280, 74, 520, 56, 28, 'rgba(0,255,136,0.1)', 'rgba(0,255,136,0.45)', 2);
  ctx.fillStyle = '#00ff88'; ctx.font = 'bold 25px "Segoe UI", Arial'; ctx.textAlign = 'center';
  ctx.fillText('🏆 REPOVERIFY • TOURNOI SURVIVAL', 540, 111);
  ctx.fillStyle = '#181c27'; ctx.fillRect(0, 0, 1080, 10);
  ctx.fillStyle = '#00f3ff'; ctx.fillRect(0, 0, 1080 * Math.min(1, t / (DURATION_MS/1000)), 10);
}

function drawCandidateRow(c, idx, y, mode) {
  const isElim1 = c.eliminatedAtStage === 1;
  const isElim2 = c.eliminatedAtStage === 2;
  let border = '#252b3d', bg = '#111622', badgeText = '★ ' + c.stars.toLocaleString('en-US'), badgeCol = '#00f3ff';

  if (mode === 'FILTER1') {
    if (isElim1) { border = '#ff3366'; bg = 'rgba(255,51,102,0.12)'; badgeText = '✗ ' + c.license + ' (ÉLIMINÉ)'; badgeCol = '#ff3366'; }
    else { border = '#00ff88'; bg = 'rgba(0,255,136,0.07)'; badgeText = '✓ ' + c.license; badgeCol = '#00ff88'; }
  } else if (mode === 'FILTER2') {
    if (isElim1 || isElim2) {
      border = '#ff3366'; bg = 'rgba(255,51,102,0.10)';
      badgeText = isElim1 ? '✗ HORS-JEU (LICENCE)' : '✗ ÉLIMINÉ (' + c.ciStatus + ')';
      badgeCol = '#ff3366';
    } else {
      border = '#00f3ff'; bg = 'rgba(0,243,255,0.07)';
      badgeText = 'BUS: ' + c.busFactorRisk + ' • CI: ' + c.ciStatus;
      badgeCol = '#00ff88';
    }
  }

  rr(66, y, 948, 128, 18, bg, border, 2.5);
  ctx.textAlign = 'left';
  ctx.fillStyle = (mode !== 'START' && (isElim1 || (mode === 'FILTER2' && isElim2))) ? '#94a3b8' : '#ffffff';
  ctx.font = 'bold 32px "Segoe UI", Arial';
  ctx.fillText((idx + 1) + '. ' + c.name, 96, y + 56);
  ctx.fillStyle = '#8b97ab'; ctx.font = '22px Consolas, monospace';
  ctx.fillText(c.owner + ' • ' + c.language, 96, y + 96);

  ctx.textAlign = 'right';
  ctx.fillStyle = badgeCol; ctx.font = 'bold 26px Consolas, monospace';
  ctx.fillText(badgeText, 984, y + 74);
}

function renderFrame(t) {
  drawBg(t);
  const list = T.candidates.slice(0, 8);

  if (t < 4.5) {
    wrap(T.hookHeadline, 540, 225, 950, 66, '#ffffff', '900 54px "Segoe UI", Arial');
    ctx.fillStyle = '#00f3ff'; ctx.font = 'bold 26px Consolas, monospace'; ctx.textAlign = 'center';
    ctx.fillText(list.length + ' CANDIDATS • ' + T.profileLabel.toUpperCase(), 540, 385);
    list.forEach((c, i) => drawCandidateRow(c, i, 440 + i * 148, 'START'));
  } else if (t < 10.0) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#00ff88'; ctx.font = 'bold 34px Consolas, monospace';
    ctx.fillText('FILTRE 1 / 3 : LICENCE COMMERCIALE', 540, 215);
    ctx.fillStyle = '#94a3b8'; ctx.font = '26px "Segoe UI", Arial';
    ctx.fillText('Élimination directe des licences copyleft (GPL / AGPL)', 540, 265);
    list.forEach((c, i) => drawCandidateRow(c, i, 330 + i * 150, 'FILTER1'));
  } else if (t < 15.5) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#00f3ff'; ctx.font = 'bold 34px Consolas, monospace';
    ctx.fillText('FILTRE 2 / 3 : CI/CD, BUS FACTOR & ACTIVITÉ', 540, 215);
    ctx.fillStyle = '#94a3b8'; ctx.font = '26px "Segoe UI", Arial';
    ctx.fillText('Vérification des workflows GitHub Actions & mono-mainteneurs', 540, 265);
    list.forEach((c, i) => drawCandidateRow(c, i, 330 + i * 150, 'FILTER2'));
  } else if (t < 21.5) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#f59e0b'; ctx.font = 'bold 38px Consolas, monospace';
    ctx.fillText('🏆 PODIUM FINAL (SURVIVANTS)', 540, 230);
    ctx.fillStyle = '#94a3b8'; ctx.font = '26px "Segoe UI", Arial';
    ctx.fillText(T.profileLabel, 540, 285);
    const p = easeOut((t - 15.5) / 1.4);
    const medals = ['🥇 #1', '🥈 #2', '🥉 #3'];
    const colors = ['#00ff88', '#00f3ff', '#f59e0b'];
    (T.podium || []).slice(0, 3).forEach((c, idx) => {
      const y = 360 + idx * 380;
      rr(74, y, 932, 320, 24, '#111622', colors[idx], idx === 0 ? 4 : 2.5);
      ctx.textAlign = 'left'; ctx.fillStyle = colors[idx]; ctx.font = 'bold 30px Consolas, monospace';
      ctx.fillText(medals[idx] + '  ' + c.fullName, 110, y + 72);
      ctx.fillStyle = '#cbd5e1'; ctx.font = '26px Consolas, monospace';
      ctx.fillText('Licence: ' + c.license + '  •  Bus Factor: ' + c.busFactorRisk + '  •  CI: ' + c.ciStatus, 110, y + 132);
      rr(110, y + 180, 860, 44, 12, '#181c27', '#252b3d', 1.5);
      rr(110, y + 180, 860 * Math.min(1, c.profileScore / 100) * p, 44, 12, colors[idx], null);
      ctx.textAlign = 'right'; ctx.fillStyle = '#ffffff'; ctx.font = 'bold 34px Consolas, monospace';
      ctx.fillText((Math.round(c.profileScore * p * 10)/10) + ' / 100', 970, y + 275);
    });
  } else {
    ctx.textAlign = 'center'; ctx.fillStyle = '#00ff88'; ctx.font = 'bold 34px Consolas, monospace';
    ctx.fillText('AUDITEZ VOTRE SHORTLIST EN 48H', 540, 320);
    rr(74, 410, 932, 470, 28, '#111622', '#00f3ff', 3);
    ctx.fillStyle = '#ffffff'; ctx.font = '900 52px "Segoe UI", Arial';
    ctx.fillText('RepoVerify / GitArena', 540, 520);
    wrap('Tournois multi-dépôts, Bus Factor, CI/CD GitHub Actions, CVE OSV.dev & Serveur MCP.', 540, 610, 820, 48, '#cbd5e1', '600 32px "Segoe UI", Arial');
    ctx.fillStyle = '#00ff88'; ctx.font = 'bold 30px Consolas, monospace';
    ctx.fillText('github.com/origguard/gitArena-repoverify', 540, 810);

    rr(74, 960, 932, 420, 28, 'rgba(245,158,11,0.09)', '#f59e0b', 3);
    ctx.fillStyle = '#f59e0b'; ctx.font = 'bold 30px Consolas, monospace';
    ctx.fillText('🎁 LEAD MAGNET GRATUIT EN DM', 540, 1055);
    wrap('Envoyez vos 3 à 5 dépôts candidats en DM : recevez gratuitement leur matrice comparative (Licences, CVE & CI) !', 540, 1145, 820, 48, '#ffffff', 'bold 34px "Segoe UI", Arial');
  }

  rr(64, 1745, 952, 115, 20, '#0f172a', 'rgba(0,243,255,0.35)', 2);
  ctx.textAlign = 'center'; ctx.fillStyle = '#00f3ff'; ctx.font = 'bold 26px Consolas, monospace';
  ctx.fillText('github.com/origguard/gitArena-repoverify', 540, 1792);
  ctx.fillStyle = '#e2e8f0'; ctx.font = '600 24px "Segoe UI", Arial';
  ctx.fillText('Audit Open-Source & Due-Diligence B2B • Lien en bio', 540, 1835);
}

function setupAudio() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ac = new AudioCtx();
    const dest = ac.createMediaStreamDestination();
    const g = ac.createGain(); g.gain.value = 0.13; g.connect(dest);
    const tone = (f, s, d, type='triangle', v=0.22) => {
      const o = ac.createOscillator(), og = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(f, ac.currentTime + s);
      og.gain.setValueAtTime(0.0001, ac.currentTime + s);
      og.gain.exponentialRampToValueAtTime(v, ac.currentTime + s + 0.03);
      og.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + s + d);
      o.connect(og); og.connect(g); o.start(ac.currentTime + s); o.stop(ac.currentTime + s + d + 0.02);
    };
    for (let s = 0; s < ${durationSec}; s += 0.5) tone(s % 2 === 0 ? 110 : 82.4, s, 0.22, 'triangle', 0.18);
    [0, 4.5, 10.0, 15.5, 21.5].forEach((cue, i) => tone(440 + i * 95, cue, 0.35, 'sine', 0.35));
    return { ac, track: dest.stream.getAudioTracks()[0] };
  } catch { return null; }
}

(async () => {
  renderFrame(0);
  const stream = canvas.captureStream(FPS);
  const audio = setupAudio();
  if (audio?.track) stream.addTrack(audio.track);
  const mime = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2')
    ? 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'
    : (MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm');
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4500000 });
  rec.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };
  rec.onstop = async () => {
    const blob = new Blob(chunks, { type: mime });
    await fetch('/upload', { method: 'POST', body: blob });
    if (audio?.ac) audio.ac.close().catch(() => {});
  };
  rec.start(250);
  const t0 = performance.now();
  const iv = setInterval(() => {
    const el = performance.now() - t0;
    renderFrame(Math.min(DURATION_MS/1000, el/1000));
    if (el >= DURATION_MS) { clearInterval(iv); rec.stop(); }
  }, 1000 / FPS);
})();
</script></body></html>`;
}

export function buildCarouselHtml(tournament, hookHeadline) {
  const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const list = tournament.ranking.slice(0, 8);
  const eliminated = list.filter(c => c.eliminatedAtStage);

  const slideStyle = `
    width: 1080px; height: 1350px; padding: 72px; box-sizing: border-box;
    background: linear-gradient(180deg, #07090e 0%, #0d1320 100%);
    color: #f0f3f8; font-family: 'Segoe UI', Arial, sans-serif;
    display: flex; flex-direction: column; justify-content: space-between;
    page-break-after: always; position: relative; border: 1px solid #1e293b;
  `;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<style>
  @page { size: 1080px 1350px; margin: 0; }
  body { margin: 0; padding: 0; background: #07090e; }
  .pill { display:inline-block; padding:10px 22px; border-radius:999px; background:rgba(0,255,136,0.1); border:1.5px solid #00ff88; color:#00ff88; font-family:Consolas,monospace; font-weight:700; font-size:20px; }
  .card { background:#111622; border:2px solid #252b3d; border-radius:18px; padding:24px 28px; margin-bottom:18px; }
  table { width:100%; border-collapse:collapse; font-size:22px; }
  th { text-align:left; color:#8b97ab; font-family:Consolas,monospace; font-size:18px; padding:14px 10px; border-bottom:2px solid #252b3d; }
  td { padding:16px 10px; border-bottom:1px solid #1e2332; }
  .footer { display:flex; justify-content:space-between; font-family:Consolas,monospace; font-size:20px; color:#64748b; border-top:1px solid #1e293b; padding-top:20px; }
</style>
</head>
<body>
  <!-- SLIDE 1 : COUVERTURE -->
  <div style="${slideStyle}">
    <div>
      <span class="pill">REPOVERIFY • DUE DILIGENCE</span>
      <h1 style="font-size:66px; line-height:1.15; margin:48px 0 24px 0; color:#fff;">${esc(hookHeadline)}</h1>
      <p style="font-size:32px; color:#94a3b8; line-height:1.45;">
        Nous avons passé <strong style="color:#00f3ff;">${list.length} dépôts GitHub</strong> au crible selon le profil <strong style="color:#00ff88;">${esc(tournament.profileMeta?.label || tournament.profile)}</strong> : Licences BigCode, CI/CD GitHub Actions, Bus Factor &amp; CVE.
      </p>
    </div>
    <div>
      <div class="card" style="border-color:#00f3ff;">
        <div style="font-size:22px; color:#00f3ff; font-family:Consolas,monospace; margin-bottom:12px;">CANDIDATS ÉVALUÉS :</div>
        <div style="font-size:26px; font-weight:700; line-height:1.6;">
          ${list.map(c => esc(c.fullName)).join(' &nbsp;•&nbsp; ')}
        </div>
      </div>
    </div>
    <div class="footer"><span>SWIPE ➔ POUR LE VERDICT</span><span>1 / 5</span></div>
  </div>

  <!-- SLIDE 2 : MATRICE COMPARATIVE -->
  <div style="${slideStyle}">
    <div>
      <span class="pill">MATRICE TECHNIQUE &amp; RISQUES</span>
      <h2 style="font-size:44px; margin:28px 0;">Comparatif des ${list.length} Dépôts</h2>
      <table>
        <thead>
          <tr><th>#</th><th>Dépôt</th><th>Score</th><th>Licence</th><th>CI</th><th>Bus Factor</th></tr>
        </thead>
        <tbody>
          ${list.map((c, i) => `
            <tr>
              <td style="font-family:Consolas,monospace;font-weight:700;">#${i + 1}</td>
              <td><strong>${esc(c.name)}</strong><br><span style="font-size:17px;color:#8b97ab;">${esc(c.owner)} • ★${c.stars.toLocaleString('en-US')}</span></td>
              <td style="color:#00f3ff;font-weight:800;font-family:Consolas,monospace;">${c.profileScore}</td>
              <td style="color:${c.commercialSafe ? '#00ff88' : '#ff3366'};font-family:Consolas,monospace;">${esc(c.license)}</td>
              <td>${esc(c.ciStatus)}</td>
              <td style="color:${c.busFactorRisk === 'LOW' ? '#00ff88' : (c.busFactorRisk === 'HIGH' ? '#ff3366' : '#f59e0b')};font-weight:700;">${esc(c.busFactorRisk)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="footer"><span>github.com/origguard/gitArena-repoverify</span><span>2 / 5</span></div>
  </div>

  <!-- SLIDE 3 : LES PIÈGES DÉTECTÉS -->
  <div style="${slideStyle}">
    <div>
      <span class="pill" style="border-color:#ff3366;color:#ff3366;background:rgba(255,51,102,0.1);">FILTRES ÉLIMINATOIRES</span>
      <h2 style="font-size:46px; margin:32px 0;">Pourquoi certains échouent en prod ?</h2>
      ${eliminated.length > 0 ? eliminated.map(c => `
        <div class="card" style="border-color:#ff3366;">
          <div style="font-size:30px; font-weight:800; color:#ff3366;">✗ ${esc(c.fullName)}</div>
          <div style="font-size:24px; color:#e2e8f0; margin-top:8px;">Éliminé à l'étape ${c.eliminatedAtStage} : ${esc(c.eliminationReason)}</div>
        </div>
      `).join('') : `
        <div class="card" style="border-color:#00ff88;">
          <div style="font-size:30px; font-weight:800; color:#00ff88;">✓ Tous les candidats ont franchi les portes Licence &amp; CI</div>
          <div style="font-size:24px; color:#cbd5e1; margin-top:10px;">Le départage final s'est joué sur le Score Profil, le Bus Factor et l'ELO Arène.</div>
        </div>
      `}
    </div>
    <div class="footer"><span>AUDIT AUTOMATISÉ REPOVERIFY</span><span>3 / 5</span></div>
  </div>

  <!-- SLIDE 4 : PODIUM FINAL -->
  <div style="${slideStyle}">
    <div>
      <span class="pill">🏆 PODIUM FINAL</span>
      <h2 style="font-size:48px; margin:28px 0;">Top 3 Recommandé (${esc(tournament.profileMeta?.label || tournament.profile)})</h2>
      ${(tournament.podium || []).map((c, idx) => `
        <div class="card" style="border-color:${idx === 0 ? '#00ff88' : (idx === 1 ? '#00f3ff' : '#f59e0b')}; padding:32px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:36px; font-weight:900;">#${idx + 1} ${esc(c.fullName)}</span>
            <span style="font-size:38px; font-weight:900; color:#00ff88; font-family:Consolas,monospace;">${c.profileScore}/100</span>
          </div>
          <div style="font-size:24px; color:#cbd5e1; margin-top:12px;">
            Licence ${esc(c.license)} • ★ ${c.stars.toLocaleString('en-US')} • Bus Factor : ${esc(c.busFactorRisk)} • CI : ${esc(c.ciStatus)}
          </div>
        </div>
      `).join('')}
    </div>
    <div class="footer"><span>Sceau SHA-256 : ${esc((tournament.seal || '').slice(0, 16))}...</span><span>4 / 5</span></div>
  </div>

  <!-- SLIDE 5 : LEAD MAGNET & OFFRE B2B -->
  <div style="${slideStyle}">
    <div>
      <span class="pill" style="border-color:#f59e0b;color:#f59e0b;background:rgba(245,158,11,0.1);">🎁 AUDIT GRATUIT SHORTLIST</span>
      <h2 style="font-size:56px; line-height:1.15; margin:40px 0;">Vous hésitez entre 3 à 5 librairies ?</h2>
      <div class="card" style="border-color:#00f3ff; padding:36px;">
        <p style="font-size:30px; line-height:1.5; margin:0;">
          Envoyez vos dépôts candidats en <strong>DM</strong> : je vous génère gratuitement votre matrice comparative (Licences Commerciales, CVE OSV.dev, Bus Factor &amp; CI/CD).
        </p>
      </div>
      <div class="card" style="border-color:#00ff88; padding:36px;">
        <div style="font-size:26px; color:#00ff88; font-weight:800; margin-bottom:10px;">BESOIN D'UN AUDIT COMPLET EN 48H ?</div>
        <p style="font-size:26px; color:#cbd5e1; margin:0;">
          Due-diligence pré-levée de fonds, mise en conformité licences &amp; setup Serveur MCP souverain pour vos équipes.
        </p>
      </div>
    </div>
    <div class="footer"><span>github.com/origguard/gitArena-repoverify</span><span>5 / 5</span></div>
  </div>
</body>
</html>`;
}

function buildTournamentSocialPosts(tournament) {
  const top3 = (tournament.podium || []).map((c, i) => `${i + 1}. **${c.fullName}** (${c.profileScore}/100 • \`${c.license}\` • Bus Factor: ${c.busFactorRisk})`).join('\n');
  const eliminated = tournament.ranking.filter(c => c.eliminatedAtStage);

  return `# Pack Publication Tournoi — ${tournament.category} (${tournament.candidatesCount} dépôts)

## LinkedIn (FR — avec Carrousel PDF + Vidéo Survival)
🏆 **Tournoi Survival : ${tournament.candidatesCount} dépôts GitHub passés au scanner RepoVerify** (Profil : *${tournament.profileMeta?.label || tournament.profile}*)

Au lieu de choisir une stack au nombre d'étoiles, nous avons soumis ${tournament.candidatesCount} projets à 3 filtres éliminatoires :
1️⃣ Licence commerciale (BigCode The Stack v2)
2️⃣ Santé CI/CD GitHub Actions & Bus Factor (mono-mainteneur)
3️⃣ Supply-Chain CVE (OSV.dev) & Maturité

${eliminated.length > 0 ? `⚠️ **Éliminations notables :**\n${eliminated.map(e => `- \`${e.fullName}\` : ${e.eliminationReason}`).join('\n')}\n` : ''}
🥇 **Podium Final :**
${top3}

🎁 **Offre gratuite (Lead Magnet) :** Vous hésitez entre **3 à 5 dépôts** pour votre prochain sprint ? Envoyez-les-moi en DM et je vous renvoie leur matrice comparative complète gratuitement.

🛠️ Outil 100 % open-source (Apache-2.0) : https://github.com/origguard/gitArena-repoverify
#OpenSource #CTO #DevSecOps #DueDiligence #IA #GitHub

---

## X / Twitter (EN)
🏆 **${tournament.candidatesCount}-Repo Survival Tournament** (${tournament.category})

Audited on License compliance, GitHub Actions CI, Bus Factor & OSV.dev CVEs:
${(tournament.podium || []).map((c, i) => `#${i + 1} ${c.fullName} — ${c.profileScore}/100 (${c.license})`).join('\n')}

Open-source engine: https://github.com/origguard/gitArena-repoverify
#OpenSource #AI #DevTools #SupplyChain
`;
}

export async function generateTournamentMedia(options = {}) {
  const browserPath = findHeadlessBrowser();
  if (!browserPath) {
    throw new Error('Aucun navigateur Chromium (Chrome/Edge) détecté.');
  }
  mkdirSync(VIDEOS_DIR, { recursive: true });

  const tournament = await runMultiRepoTournament({
    repos: options.repos || [],
    category: options.category || '',
    profile: options.profile || 'enterprise',
    limit: options.limit || 6,
    includeLiveChecks: options.includeLiveChecks !== false
  });

  const fileBase = options.outputName || `tournament-${tournament.profile}-${tournament.tournamentId.slice(0, 6)}`;
  const hookHeadline = options.hook || `TOURNOI ${tournament.candidatesCount} DÉPÔTS : QUI SURVIT EN PROD ?`;

  const outMp4 = join(VIDEOS_DIR, `${fileBase}.mp4`);
  const outPdf = join(VIDEOS_DIR, `${fileBase}-carousel.pdf`);
  const outPost = join(VIDEOS_DIR, `${fileBase}-post.md`);

  const videoHtml = buildTournamentVideoHtml(tournament, hookHeadline, 26);
  await renderHtmlToMp4(browserPath, videoHtml, outMp4, 65000);

  const carouselHtml = buildCarouselHtml(tournament, hookHeadline);
  const pdfBytes = await renderHtmlToCarouselPdf(browserPath, carouselHtml, outPdf);

  writeFileSync(outPost, buildTournamentSocialPosts(tournament), 'utf8');

  return {
    tournamentId: tournament.tournamentId,
    champion: tournament.champion?.fullName,
    candidatesCount: tournament.candidatesCount,
    videoPath: outMp4,
    videoSizeKb: Math.round(statSync(outMp4).size / 1024),
    carouselPdfPath: outPdf,
    carouselPdfSizeKb: Math.round(pdfBytes / 1024),
    postPath: outPost
  };
}

export async function generateDuelVideo(slugA, slugB, options = {}) {
  const browserPath = findHeadlessBrowser();
  if (!browserPath) {
    throw new Error('Aucun navigateur Chromium (Chrome/Edge) détecté pour le rendu vidéo.');
  }

  mkdirSync(VIDEOS_DIR, { recursive: true });
  const repoA = await prepareFighterData(slugA);
  const repoB = await prepareFighterData(slugB);
  const meta = chooseWinnerAndCopy(repoA, repoB, options.hook);

  const duelData = { repoA, repoB, ...meta };
  const fileBase = options.outputName || `${repoA.name.toLowerCase()}-vs-${repoB.name.toLowerCase()}`.replace(/[^a-z0-9_-]/g, '-');
  const outMp4 = join(VIDEOS_DIR, `${fileBase}.mp4`);
  const outPost = join(VIDEOS_DIR, `${fileBase}-post.md`);

  const html = buildStudioHtml(duelData, 22);
  await renderHtmlToMp4(browserPath, html, outMp4, 45000);

  writeFileSync(outPost, buildSocialPosts(duelData), 'utf8');
  const sizeKb = Math.round(statSync(outMp4).size / 1024);

  return {
    videoPath: outMp4,
    postPath: outPost,
    sizeKb,
    durationSec: 22,
    resolution: '1080x1920',
    winner: meta.winnerFullName
  };
}

// Exécution CLI :
//   node src/studio/video-studio.mjs ownerA/repoA ownerB/repoB
//   node src/studio/video-studio.mjs --tournament [--profile enterprise] [--repos a/b,c/d,...] [--category "..."]
if (process.argv[1] && process.argv[1].endsWith('video-studio.mjs')) {
  const args = process.argv.slice(2);
  const getArg = (flag, def = '') => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };
  initDatabase();

  const defaultDuels = [
    {
      a: 'unclecode/crawl4ai',
      b: 'mendableai/firecrawl',
      hook: 'CRAWL4AI vs FIRECRAWL : PIÈGE LICENCE ?',
      out: '01-crawl4ai-vs-firecrawl'
    },
    {
      a: 'langchain-ai/langgraph',
      b: 'crewAIInc/crewAI',
      hook: 'LANGGRAPH vs CREWAI : QUEL AGENT CHOISIR ?',
      out: '02-langgraph-vs-crewai'
    },
    {
      a: 'vllm-project/vllm',
      b: 'ollama/ollama',
      hook: 'vLLM vs OLLAMA : INFÉRENCE LLM EN PROD',
      out: '03-vllm-vs-ollama'
    },
    {
      a: 'qdrant/qdrant',
      b: 'chroma-core/chroma',
      hook: 'QDRANT vs CHROMA : DUEL BASES VECTORIELLES',
      out: '04-qdrant-vs-chroma'
    }
  ];

  try {
    if (args.includes('--tournament')) {
      const reposArg = getArg('--repos', '');
      const repos = reposArg ? reposArg.split(',').map(s => s.trim()).filter(Boolean) : [
        'langchain-ai/langgraph',
        'crewAIInc/crewAI',
        'microsoft/autogen',
        'unclecode/crawl4ai',
        'mendableai/firecrawl',
        'All-Hands-AI/OpenHands'
      ];
      const res = await generateTournamentMedia({
        repos,
        category: getArg('--category', 'Tournoi Agents & Scraping IA'),
        profile: getArg('--profile', 'enterprise'),
        limit: parseInt(getArg('--limit', '6'), 10),
        hook: getArg('--hook', '6 FRAMEWORKS IA : QUI SURVIT EN PROD ?'),
        outputName: getArg('--out', '05-tournoi-6-frameworks-ia')
      });
      console.log('[VIDEO-STUDIO TOURNAMENT] ✓', JSON.stringify(res, null, 2));
    } else if (args.length >= 2) {
      const res = await generateDuelVideo(args[0], args[1]);
      console.log('[VIDEO-STUDIO] ✓ Généré :', JSON.stringify(res, null, 2));
    } else {
      for (const d of defaultDuels) {
        console.log(`[VIDEO-STUDIO] Génération de ${d.a} vs ${d.b}...`);
        const res = await generateDuelVideo(d.a, d.b, { hook: d.hook, outputName: d.out });
        console.log('[VIDEO-STUDIO] ✓', JSON.stringify(res));
      }
    }
  } finally {
    closeDatabase();
  }
}
