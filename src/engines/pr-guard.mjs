import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initDatabase, closeDatabase } from '../db/database.mjs';
import { scanDirectoryBehavior } from './behavioral-firewall.mjs';
import { scanDependenciesVulnerabilities } from './osv-scanner.mjs';
import { PERMISSIVE_LICENSES } from './repo-service.mjs';

/**
 * PR Guard Gatekeeper — Pilier 2 (RepoVerify / GitArena)
 * Vérifie un dépôt local ou une Pull Request (Behavioral Firewall + Licence + CVE OSV.dev)
 * Retourne Exit Code 0 (ALLOW) ou Exit Code 1 (DENY / Block PR).
 */

export function detectProjectDependencies(projectDir) {
  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const runtime = Object.keys(pkg.dependencies || {});
      return {
        license: pkg.license || 'Non spécifiée',
        dependencies: {
          manager: 'npm / yarn / pnpm',
          runtime,
          count: runtime.length
        }
      };
    } catch { /* ignore */ }
  }

  const reqPath = join(projectDir, 'requirements.txt');
  if (existsSync(reqPath)) {
    const runtime = readFileSync(reqPath, 'utf8')
      .split('\n')
      .map(l => l.trim().split(/[>=<!\[#;]/)[0].trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('-'));
    return {
      license: 'Python Project',
      dependencies: { manager: 'pip', runtime, count: runtime.length }
    };
  }

  return {
    license: existsSync(join(projectDir, 'LICENSE')) ? 'LICENSE file present' : 'Non spécifiée',
    dependencies: { manager: 'Inconnu', runtime: [], count: 0 }
  };
}

export async function runPrGuard(targetDir = process.cwd(), options = {}) {
  const resolvedDir = resolve(targetDir);
  const policyProfile = options.profile || 'enterprise';
  const skipNetwork = Boolean(options.offline);

  // 1. Behavioral Firewall sur le répertoire
  const behavior = scanDirectoryBehavior(resolvedDir);

  // 2. Détection manifeste & licence
  const manifest = detectProjectDependencies(resolvedDir);
  const licensePath = join(resolvedDir, 'LICENSE');
  let detectedLicense = manifest.license;
  if (existsSync(licensePath) && (detectedLicense === 'Non spécifiée' || detectedLicense === 'LICENSE file present')) {
    const licHead = readFileSync(licensePath, 'utf8').slice(0, 600);
    if (/Apache License/i.test(licHead)) detectedLicense = 'Apache-2.0';
    else if (/MIT License/i.test(licHead)) detectedLicense = 'MIT';
    else if (/GNU AFFERO GENERAL PUBLIC/i.test(licHead)) detectedLicense = 'AGPL-3.0';
    else if (/GNU GENERAL PUBLIC LICENSE/i.test(licHead)) detectedLicense = 'GPL-3.0';
  }

  const isPermissive = PERMISSIVE_LICENSES.includes(String(detectedLicense).toLowerCase());

  // 3. Scan OSV.dev sur les dépendances
  const osv = !skipNetwork && manifest.dependencies.count > 0
    ? await scanDependenciesVulnerabilities(manifest.dependencies)
    : { scanned: false, totalVulnerabilities: 0, maxSeverity: 'NONE', findings: [] };

  const blockers = [];
  if (behavior.verdict === 'BLOCK_SUSPICIOUS') {
    blockers.push(`Behavioral Firewall : ${behavior.findingsCount} alerte(s) critique(s) (score ${behavior.riskScore}/100)`);
  }
  if ((policyProfile === 'strict' || policyProfile === 'enterprise') && !isPermissive && detectedLicense !== 'Non spécifiée') {
    blockers.push(`Licence ${detectedLicense} non permissive (risque copyleft)`);
  }
  if (osv.scanned && (osv.maxSeverity === 'CRITICAL' || (policyProfile === 'strict' && osv.maxSeverity === 'HIGH'))) {
    blockers.push(`OSV.dev : ${osv.totalVulnerabilities} CVE (gravité max : ${osv.maxSeverity})`);
  }

  const passed = blockers.length === 0;
  return {
    passed,
    exitCode: passed ? 0 : 1,
    policyProfile,
    directory: resolvedDir,
    license: detectedLicense,
    commercialSafe: isPermissive,
    behavioralAudit: behavior,
    osvScan: osv,
    blockers
  };
}

if (process.argv[1] && process.argv[1].endsWith('pr-guard.mjs')) {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--')) || process.cwd();
  const offline = args.includes('--offline');
  const strict = args.includes('--strict');

  initDatabase();
  const report = await runPrGuard(dir, { offline, profile: strict ? 'strict' : 'enterprise' });
  console.log(JSON.stringify(report, null, 2));
  closeDatabase();
  process.exit(report.exitCode);
}
