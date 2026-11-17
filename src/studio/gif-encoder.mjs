import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, closeDatabase } from '../db/database.mjs';
import { runMultiRepoTournament } from '../engines/tournament-engine.mjs';
import { findHeadlessBrowser } from './video-studio.mjs';

/**
 * Encodeur GIF89a + LZW Pur Node.js ESM (Zéro dépendance NPM, Zéro FFmpeg)
 * Génère un GIF animé Showcase compact (800x450) pour README GitHub à partir des données réelles.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Construit une palette déterministe 256 couleurs (cube 6x6x6 = 216 + 16 gris + 24 couleurs marque)
 */
export function buildBrandPalette() {
  const palette = new Uint8Array(256 * 3);
  let idx = 0;

  // 216 couleurs uniformes (6x6x6)
  const levels = [0, 51, 102, 153, 204, 255];
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) {
        palette[idx++] = r;
        palette[idx++] = g;
        palette[idx++] = b;
      }
    }
  }

  // 16 niveaux de gris
  for (let i = 0; i < 16; i++) {
    const v = Math.round((i / 15) * 255);
    palette[idx++] = v;
    palette[idx++] = v;
    palette[idx++] = v;
  }

  // 24 couleurs exactes du thème Cyber-Industrial RepoVerify
  const brandColors = [
    [7, 9, 14], [12, 18, 32], [17, 22, 34], [24, 28, 39],
    [15, 23, 42], [37, 43, 61], [0, 255, 136], [0, 243, 255],
    [245, 158, 11], [255, 51, 102], [203, 213, 225], [148, 163, 184],
    [139, 151, 171], [100, 116, 139], [16, 48, 38], [14, 42, 54],
    [48, 18, 28], [46, 34, 16], [56, 189, 248], [168, 85, 247],
    [30, 41, 59], [226, 232, 240], [18, 36, 48], [2, 6, 23]
  ];
  for (const [r, g, b] of brandColors) {
    palette[idx++] = r;
    palette[idx++] = g;
    palette[idx++] = b;
  }

  return palette;
}

function mapRgbaToPalette(rgba, palette, width, height) {
  const count = width * height;
  const indices = new Uint8Array(count);
  // Cache RGB -> palette index pour accélérer énormément sur fonds uniformes
  const cache = new Map();

  for (let p = 0; p < count; p++) {
    const off = p * 4;
    const r = rgba[off];
    const g = rgba[off + 1];
    const b = rgba[off + 2];
    const key = (r << 16) | (g << 8) | b;

    let bestIdx = cache.get(key);
    if (bestIdx === undefined) {
      let bestDist = Infinity;
      bestIdx = 0;
      for (let i = 0; i < 256; i++) {
        const pi = i * 3;
        const dr = r - palette[pi];
        const dg = g - palette[pi + 1];
        const db = b - palette[pi + 2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
          if (dist === 0) break;
        }
      }
      cache.set(key, bestIdx);
    }
    indices[p] = bestIdx;
  }
  return indices;
}

function lzwEncode(indices, minCodeSize = 8) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  const bytes = [];
  let bitBuf = 0;
  let bitCount = 0;

  const emit = (code, bits) => {
    bitBuf |= code << bitCount;
    bitCount += bits;
    while (bitCount >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  };

  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map();

  const resetDict = () => {
    dict = new Map();
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };

  emit(clearCode, codeSize);
  let prefix = indices[0];

  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
    } else {
      emit(prefix, codeSize);
      if (nextCode < 4096) {
        dict.set(key, nextCode);
        if (nextCode === (1 << codeSize) && codeSize < 12) {
          codeSize++;
        }
        nextCode++;
      } else {
        emit(clearCode, codeSize);
        resetDict();
      }
      prefix = k;
    }
  }

  emit(prefix, codeSize);
  emit(eoiCode, codeSize);
  if (bitCount > 0) {
    bytes.push(bitBuf & 0xff);
  }

  // Empaqueter en sous-blocs GIF (max 255 octets par bloc)
  const out = [minCodeSize];
  for (let i = 0; i < bytes.length; i += 255) {
    const slice = bytes.slice(i, i + 255);
    out.push(slice.length, ...slice);
  }
  out.push(0); // Terminateur de bloc
  return Buffer.from(out);
}

/**
 * Encode une liste de buffers RGBA bruts en un buffer GIF89a complet
 */
export function encodeGif89a(framesRgba, width, height, delayCs = 14) {
  const palette = buildBrandPalette();
  const chunks = [];

  // 1. Header GIF89a + Logical Screen Descriptor
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'ascii');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0xf7; // Global Color Table (256 couleurs, 8-bit)
  header[11] = 0;
  header[12] = 0;
  chunks.push(header);

  // 2. Global Color Table
  chunks.push(Buffer.from(palette));

  // 3. Netscape 2.0 Loop Extension (boucle infinie)
  chunks.push(Buffer.from([
    0x21, 0xff, 0x0b,
    0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
    0x03, 0x01, 0x00, 0x00, 0x00
  ]));

  // 4. Frames
  for (const rgba of framesRgba) {
    // Graphic Control Extension
    const gce = Buffer.alloc(8);
    gce[0] = 0x21; gce[1] = 0xf9; gce[2] = 0x04; gce[3] = 0x04;
    gce.writeUInt16LE(delayCs, 4);
    gce[6] = 0x00; gce[7] = 0x00;
    chunks.push(gce);

    // Image Descriptor
    const imgDesc = Buffer.alloc(10);
    imgDesc[0] = 0x2c;
    imgDesc.writeUInt16LE(0, 1);
    imgDesc.writeUInt16LE(0, 3);
    imgDesc.writeUInt16LE(width, 5);
    imgDesc.writeUInt16LE(height, 7);
    imgDesc[9] = 0x00;
    chunks.push(imgDesc);

    // LZW Data
    const indices = mapRgbaToPalette(rgba, palette, width, height);
    chunks.push(lzwEncode(indices, 8));
  }

  // 5. Trailer
  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}

function buildGifRendererHtml(tournament, width = 800, height = 450, totalFrames = 60) {
  const safeJson = JSON.stringify({
    candidates: tournament.ranking.slice(0, 6),
    podium: tournament.podium.slice(0, 3),
    champion: tournament.champion
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html><body style="margin:0;background:#07090e;">
<canvas id="c" width="${width}" height="${height}"></canvas>
<script>
const D = ${safeJson};
const W = ${width}, H = ${height}, TOTAL = ${totalFrames};
const ctx = document.getElementById('c').getContext('2d');

function rr(x, y, w, h, r, fill, stroke, lw = 1.5) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

function drawScene(frameIdx) {
  const p = frameIdx / TOTAL;
  ctx.fillStyle = '#07090e';
  ctx.fillRect(0, 0, W, H);

  // Grille discrète
  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 80) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y < H; y += 75) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  // Header constant
  rr(24, 18, 250, 28, 14, '#103026', '#00ff88', 1.5);
  ctx.fillStyle = '#00ff88'; ctx.font = 'bold 13px Consolas, monospace'; ctx.textAlign = 'center';
  ctx.fillText('✓ REPOVERIFY / GITARENA', 149, 36);

  ctx.textAlign = 'right'; ctx.fillStyle = '#00f3ff'; ctx.font = 'bold 13px Consolas, monospace';
  ctx.fillText('SURVIVAL TOURNAMENT • ENTERPRISE', W - 26, 36);

  // Barre de progression
  ctx.fillStyle = '#181c27'; ctx.fillRect(24, 54, W - 48, 4);
  ctx.fillStyle = '#00f3ff'; ctx.fillRect(24, 54, (W - 48) * p, 4);

  const stage = p < 0.28 ? 0 : (p < 0.56 ? 1 : (p < 0.80 ? 2 : 3));

  if (stage === 0) {
    ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff'; ctx.font = 'bold 26px "Segoe UI", Arial';
    ctx.fillText('Tournoi 6 Frameworks IA : Qui passe la prod ?', 26, 98);
    ctx.fillStyle = '#94a3b8'; ctx.font = '15px "Segoe UI", Arial';
    ctx.fillText('Audit réel : Licences BigCode, CI/CD GitHub Actions, Bus Factor & CVE OSV.dev', 26, 124);

    D.candidates.forEach((c, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 26 + col * 382, y = 148 + row * 82;
      rr(x, y, 366, 70, 10, '#111622', '#252b3d', 1.5);
      ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff'; ctx.font = 'bold 17px "Segoe UI", Arial';
      ctx.fillText((i+1) + '. ' + c.name, x + 16, y + 30);
      ctx.fillStyle = '#8b97ab'; ctx.font = '13px Consolas, monospace';
      ctx.fillText(c.owner + ' • ' + c.language, x + 16, y + 52);
      ctx.textAlign = 'right'; ctx.fillStyle = '#00f3ff'; ctx.font = 'bold 14px Consolas, monospace';
      ctx.fillText('★ ' + c.stars.toLocaleString('en-US'), x + 350, y + 40);
    });
  } else if (stage === 1) {
    ctx.textAlign = 'left'; ctx.fillStyle = '#00ff88'; ctx.font = 'bold 22px Consolas, monospace';
    ctx.fillText('FILTRE 1 / 2 : LICENCE COMMERCIALE & BUS FACTOR', 26, 98);
    D.candidates.forEach((c, i) => {
      const elim = c.eliminatedAtStage === 1;
      const col = i % 2, row = Math.floor(i / 2);
      const x = 26 + col * 382, y = 132 + row * 88;
      rr(x, y, 366, 74, 10, elim ? '#30121c' : '#103026', elim ? '#ff3366' : '#00ff88', 2);
      ctx.textAlign = 'left'; ctx.fillStyle = elim ? '#cbd5e1' : '#ffffff'; ctx.font = 'bold 17px "Segoe UI", Arial';
      ctx.fillText((elim ? '✗ ' : '✓ ') + c.name, x + 16, y + 32);
      ctx.fillStyle = elim ? '#ff3366' : '#00ff88'; ctx.font = 'bold 13px Consolas, monospace';
      ctx.fillText(elim ? ('ÉLIMINÉ (' + c.license + ')') : ('OK : ' + c.license + ' • BUS: ' + c.busFactorRisk), x + 16, y + 56);
    });
  } else if (stage === 2) {
    ctx.textAlign = 'left'; ctx.fillStyle = '#f59e0b'; ctx.font = 'bold 22px Consolas, monospace';
    ctx.fillText('🏆 PODIUM FINAL (SURVIVANTS)', 26, 98);
    const anim = Math.min(1, (p - 0.56) / 0.12);
    const cols = ['#00ff88', '#00f3ff', '#f59e0b'];
    D.podium.forEach((c, i) => {
      const y = 130 + i * 92;
      rr(26, y, W - 52, 78, 12, '#111622', cols[i], 2);
      ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff'; ctx.font = 'bold 19px "Segoe UI", Arial';
      ctx.fillText('#' + (i+1) + '  ' + c.fullName, 44, y + 32);
      ctx.fillStyle = '#94a3b8'; ctx.font = '13px Consolas, monospace';
      ctx.fillText(c.license + ' • CI: ' + c.ciStatus + ' • Bus Factor: ' + c.busFactorRisk, 44, y + 58);

      rr(420, y + 24, 240, 22, 6, '#181c27', '#252b3d', 1);
      rr(420, y + 24, 240 * (c.profileScore / 100) * anim, 22, 6, cols[i], null);
      ctx.textAlign = 'right'; ctx.fillStyle = cols[i]; ctx.font = 'bold 20px Consolas, monospace';
      ctx.fillText((Math.round(c.profileScore * anim * 10)/10) + '/100', W - 44, y + 43);
    });
  } else {
    rr(26, 96, W - 52, 290, 16, '#111622', '#00f3ff', 2);
    ctx.textAlign = 'center'; ctx.fillStyle = '#00ff88'; ctx.font = 'bold 22px Consolas, monospace';
    ctx.fillText('100% NODE.JS ESM • ZÉRO DÉPENDANCE NPM', W / 2, 160);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 34px "Segoe UI", Arial';
    ctx.fillText('RepoVerify / GitArena', W / 2, 225);
    ctx.fillStyle = '#cbd5e1'; ctx.font = '18px "Segoe UI", Arial';
    ctx.fillText('Inspecteur CI/CD • Scan CVE OSV.dev • Sandbox Docker • Serveur MCP', W / 2, 278);
    ctx.fillStyle = '#00f3ff'; ctx.font = 'bold 20px Consolas, monospace';
    ctx.fillText('github.com/origguard/gitArena-repoverify', W / 2, 336);
  }

  // Footer
  ctx.textAlign = 'left'; ctx.fillStyle = '#64748b'; ctx.font = '12px Consolas, monospace';
  ctx.fillText('npm start • http://localhost:8080 • Open-Source Apache-2.0', 26, H - 16);
}

(async () => {
  for (let i = 0; i < TOTAL; i++) {
    drawScene(i);
    const imgData = ctx.getImageData(0, 0, W, H).data;
    await fetch('/frame/' + i, { method: 'POST', body: imgData.buffer });
  }
  await fetch('/done', { method: 'POST' });
})();
</script></body></html>`;
}

export async function generateShowcaseGif(options = {}) {
  const browserPath = findHeadlessBrowser();
  if (!browserPath) {
    throw new Error('Aucun navigateur Chromium (Chrome/Edge) détecté pour rendre le GIF.');
  }

  const width = options.width || 800;
  const height = options.height || 450;
  const totalFrames = options.frames || 48; // 8s à 6 fps (très léger et fluide)
  const delayCs = options.delayCs || 16;    // ~6.25 fps

  const tournament = await runMultiRepoTournament({
    repos: options.repos || [
      'langchain-ai/langgraph',
      'crewAIInc/crewAI',
      'microsoft/autogen',
      'unclecode/crawl4ai',
      'mendableai/firecrawl',
      'All-Hands-AI/OpenHands'
    ],
    category: 'Tournoi Agents & Scraping IA',
    profile: 'enterprise',
    limit: 6,
    includeLiveChecks: false
  });

  const html = buildGifRendererHtml(tournament, width, height, totalFrames);
  const framesRgba = new Array(totalFrames);

  await new Promise((resolve, reject) => {
    let browserProc = null;
    let settled = false;

    const srv = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (req.method === 'POST' && req.url.startsWith('/frame/')) {
        const idx = parseInt(req.url.replace('/frame/', ''), 10);
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          framesRgba[idx] = Buffer.concat(chunks);
          res.writeHead(200);
          res.end('OK');
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/done') {
        res.writeHead(200);
        res.end('OK');
        settled = true;
        if (browserProc) browserProc.kill();
        srv.close(() => resolve());
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        if (browserProc) browserProc.kill();
        srv.close();
        reject(new Error('Timeout capture frames GIF'));
      }
    }, 35000);

    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      browserProc = spawn(browserPath, [
        '--headless=new',
        '--window-size=800,450',
        `http://127.0.0.1:${port}/`
      ], { stdio: 'ignore' });

      browserProc.on('close', () => {
        clearTimeout(timeout);
        if (!settled) {
          srv.close();
          reject(new Error('Navigateur fermé avant fin capture GIF'));
        }
      });
    });
  });

  const assetsDir = join(__dirname, '../../assets');
  mkdirSync(assetsDir, { recursive: true });
  const outGif = join(assetsDir, options.filename || 'repoverify-showcase.gif');

  const gifBuffer = encodeGif89a(framesRgba, width, height, delayCs);
  writeFileSync(outGif, gifBuffer);

  return {
    gifPath: outGif,
    sizeKb: Math.round(statSync(outGif).size / 1024),
    frames: totalFrames,
    dimensions: `${width}x${height}`
  };
}

if (process.argv[1] && process.argv[1].endsWith('gif-encoder.mjs')) {
  initDatabase();
  try {
    const res = await generateShowcaseGif();
    console.log('[GIF-ENCODER] ✓ GIF généré :', JSON.stringify(res, null, 2));
  } finally {
    closeDatabase();
  }
}
