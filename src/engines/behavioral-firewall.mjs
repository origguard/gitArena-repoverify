import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/database.mjs';
import { decide } from './evidence.mjs';

/**
 * Analyse Comportementale Statique (Pre-Flight) — Pilier 1 (RepoVerify / GitArena)
 * Détecte statiquement les vecteurs d'exfiltration (.ssh, .aws, .env), hooks postinstall,
 * exécution dynamique obfusquée et émissions réseau explicites dans les sources.
 * Ne constitue pas une observation runtime (eBPF/strace). 100 % Natif Node.js ESM.
 */

const SCANNABLE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sh', '.ps1', '.rb', '.go', '.rs']);
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', 'tests', '__tests__']);

const BEHAVIOR_RULES = [
  {
    id: 'CREDENTIAL_HARVEST_SSH_AWS',
    severity: 'CRITICAL',
    weight: 45,
    description: 'Tentative d\'accès aux clés privées ou secrets système (id_rsa, id_ed25519, .aws/credentials, .npmrc, .netrc)',
    regex: /(\/\.ssh\/id_rsa|\/\.ssh\/id_ed25519|\/\.aws\/credentials|\.npmrc|\.netrc|\/etc\/shadow)/i
  },
  {
    id: 'OBFUSCATED_DYNAMIC_EXEC',
    severity: 'HIGH',
    weight: 30,
    description: 'Exécution de charge utile encodée / obfusquée (base64/zlib + eval/exec)',
    regex: /(eval\s*\(\s*(Buffer\.from|atob)|new\s+Function\s*\(|exec\s*\(\s*zlib\.decompress|base64\.b64decode\s*\([^)]+\)\s*\))/i
  },
  {
    id: 'REMOTE_PIPE_SHELL',
    severity: 'CRITICAL',
    weight: 40,
    description: 'Téléchargement et exécution directe en shell (curl/wget | sh/bash/powershell)',
    regex: /(curl\s+[^|\n]+\|\s*(sh|bash|zsh)|wget\s+[^|\n]+\|\s*(sh|bash)|powershell\s+.*-EncodedCommand)/i
  },
  {
    id: 'SHELL_SPAWN_PRIMITIVE',
    severity: 'MEDIUM',
    weight: 15,
    description: 'Invocation de sous-shell système (child_process.exec, os.system, shell=True)',
    regex: /(child_process['"]?\s*\)\s*\.exec\b|\bos\.system\s*\(|subprocess\.(Popen|run|call)\s*\([^)]*shell\s*=\s*True)/i
  },
  {
    id: 'ENV_EXFIL_PATTERN',
    severity: 'HIGH',
    weight: 30,
    description: 'Lecture massive d\'environnement (process.env / os.environ) couplée à une requête sortante',
    regex: /((JSON\.stringify\s*\(\s*process\.env\s*\)|dict\s*\(\s*os\.environ\s*\))[\s\S]{0,200}(fetch|axios|http\.request|requests\.post))/i
  },
  {
    id: 'OUTBOUND_NETWORK_CALL',
    severity: 'LOW',
    weight: 4,
    description: 'Appel réseau sortant explicite détecté (à vérifier si mode Zero-Egress requis)',
    regex: /\b(fetch\s*\(\s*['"]https?:\/\/|https\.request\s*\(|requests\.(get|post)\s*\(\s*['"]https?:\/\/|new\s+WebSocket\s*\()/i
  }
];

const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

export function scanPackageJsonHooks(pkgText) {
  const findings = [];
  try {
    const pkg = JSON.parse(pkgText);
    const scripts = pkg.scripts || {};
    for (const hook of ['preinstall', 'install', 'postinstall', 'preuninstall', 'prepare']) {
      if (typeof scripts[hook] === 'string' && scripts[hook].trim()) {
        const cmd = scripts[hook];
        const isDangerous = /(curl|wget|powershell|bash\s+-c|sh\s+-c|node\s+-e|python\s+-c|eval)/i.test(cmd);
        findings.push({
          ruleId: isDangerous ? 'DANGEROUS_INSTALL_HOOK' : 'LIFECYCLE_INSTALL_HOOK',
          severity: isDangerous ? 'CRITICAL' : 'MEDIUM',
          weight: isDangerous ? 45 : 15,
          file: 'package.json',
          detail: `Script "${hook}": ${cmd.slice(0, 140)}`,
          description: isDangerous
            ? `Hook "${hook}" exécute une commande shell/réseau suspecte dès l'installation.`
            : `Hook "${hook}" présent dans package.json (exécuté automatiquement par npm install sauf --ignore-scripts).`
        });
      }
    }
  } catch { /* JSON invalide */ }
  return findings;
}

export function scanTextBehavior(content, fileLabel = 'source') {
  const findings = [];
  if (!content || typeof content !== 'string') return findings;

  const snippet = content.slice(0, 250000);
  for (const rule of BEHAVIOR_RULES) {
    const match = snippet.match(rule.regex);
    if (match) {
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        weight: rule.weight,
        file: fileLabel,
        detail: match[0].slice(0, 120),
        description: rule.description
      });
    }
  }
  return findings;
}

export function summarizeBehavioralFindings(findings, scanMode = 'STATIC', context = {}) {
  // Dédupliquer par ruleId + file
  const uniqueMap = new Map();
  for (const f of findings) {
    const k = `${f.ruleId}:${f.file}`;
    if (!uniqueMap.has(k)) uniqueMap.set(k, f);
  }
  const unique = [...uniqueMap.values()];
  unique.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));

  let rawRisk = 0;
  for (const f of unique) {
    rawRisk += f.weight || 0;
  }

  const riskScore = Math.min(100, rawRisk);
  const normalizedMode = scanMode === 'DIR_NOT_FOUND' ? null : 'STATIC';
  const decided = decide({
    behavioral: normalizedMode ? { scanMode: normalizedMode, findings: unique, ref: context.ref || null } : null,
    osv: context.osv || null,
    execution: context.execution || null
  });

  return {
    scanMode,
    verdict: decided.verdict,
    evidenceLevel: decided.evidenceLevel,
    riskScore,
    findingsCount: unique.length,
    findings: unique.slice(0, 25)
  };
}

/**
 * Scanne récursivement un répertoire cloné localement avant exécution Sandbox
 */
export function scanDirectoryBehavior(rootDir) {
  if (!rootDir || !existsSync(rootDir)) {
    return summarizeBehavioralFindings([], 'DIR_NOT_FOUND');
  }

  const allFindings = [];
  const pkgPath = join(rootDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      allFindings.push(...scanPackageJsonHooks(readFileSync(pkgPath, 'utf8')));
    } catch { /* ignore */ }
  }

  let filesScanned = 0;
  const maxFiles = 250;

  function walk(dir, relPrefix = '') {
    if (filesScanned >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (filesScanned >= maxFiles) break;
      if (ent.isDirectory()) {
        if (!IGNORE_DIRS.has(ent.name)) {
          walk(join(dir, ent.name), relPrefix ? `${relPrefix}/${ent.name}` : ent.name);
        }
      } else if (ent.isFile() && ent.name !== 'behavioral-firewall.mjs' && SCANNABLE_EXTS.has(extname(ent.name).toLowerCase())) {
        const fullPath = join(dir, ent.name);
        const relPath = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
        try {
          const st = statSync(fullPath);
          if (st.size > 0 && st.size <= 150000) {
            const text = readFileSync(fullPath, 'utf8');
            allFindings.push(...scanTextBehavior(text, relPath));
            filesScanned++;
          }
        } catch { /* ignore unreadable file */ }
      }
    }
  }

  walk(rootDir);
  const summary = summarizeBehavioralFindings(allFindings, 'LOCAL_CLONE_PREFLIGHT');
  summary.filesScanned = filesScanned;
  return summary;
}

export function persistBehavioralAudit(fullName, summary) {
  const id = randomUUID();
  const receiptSha256 = createHash('sha256')
    .update(`${fullName}:${summary.verdict}:${summary.riskScore}:${summary.findingsCount}:${Date.now()}`)
    .digest('hex');

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO behavioral_audits (
        id, full_name, verdict, risk_score, findings_json, scan_mode, receipt_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fullName,
      summary.verdict,
      summary.riskScore,
      JSON.stringify(summary.findings || []),
      summary.scanMode || 'STATIC_PREFLIGHT',
      receiptSha256
    );
  } catch { /* ignore in isolated unit tests */ }

  return { id, receiptSha256, ...summary };
}

export function getLatestBehavioralAudit(fullName) {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM behavioral_audits
      WHERE full_name = ?
      ORDER BY scanned_at DESC
      LIMIT 1
    `).get(fullName);
    if (!row) return null;
    return {
      id: row.id,
      fullName: row.full_name,
      verdict: row.verdict,
      riskScore: row.risk_score,
      findings: JSON.parse(row.findings_json || '[]'),
      findingsCount: JSON.parse(row.findings_json || '[]').length,
      scanMode: row.scan_mode,
      receiptSha256: row.receipt_sha256,
      scannedAt: row.scanned_at
    };
  } catch {
    return null;
  }
}
