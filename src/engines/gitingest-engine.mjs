import { createHash } from 'node:crypto';
import { getDb } from '../db/database.mjs';
import { buildGithubHeaders } from './ci-telemetry.mjs';

/**
 * Moteur d'Ingestion Profonde GitIngest & Fallback GitHub Trees — RepoVerify
 * Extrait l'arbre de fichiers, dépendances (npm, pip, Cargo, Go), lockfiles,
 * scripts réels, contraintes runtime et métriques de compatibilité LLM.
 * Zéro dépendance NPM.
 */

const GITINGEST_API = 'https://gitingest.com/api';
const TIMEOUT_MS = 15000;

export async function fetchGitIngestRaw(owner, name) {
  const slug = `${owner}/${name}`;
  try {
    const url = `${GITINGEST_API}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RepoVerify-Sovereign-Engine/3.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    if (!res.ok) {
      console.warn(`[GITINGEST] Réponse ${res.status} pour ${slug}`);
      return null;
    }

    const data = await res.json();
    console.log(`[GITINGEST] ✓ Digest récupéré pour ${slug} (${data.summary || 'N/A'})`);
    return data;
  } catch (err) {
    console.warn(`[GITINGEST] Échec pour ${slug}:`, err.message);
    return null;
  }
}

/**
 * Fallback résilient via GitHub API Trees + Raw Manifests si GitIngest est indisponible/trop lent
 */
export async function fetchGithubTreeFallback(owner, name) {
  const slug = `${owner}/${name}`;
  try {
    const headers = buildGithubHeaders();
    const repoRes = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      headers,
      signal: AbortSignal.timeout(6000)
    });
    if (!repoRes.ok) return null;
    const repoData = await repoRes.json();
    const branch = repoData.default_branch || 'main';

    const treeRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      { headers, signal: AbortSignal.timeout(8000) }
    );
    if (!treeRes.ok) return null;
    const treeJson = await treeRes.json();
    const entries = Array.isArray(treeJson.tree) ? treeJson.tree : [];
    const paths = entries.map(e => e.type === 'tree' ? `${e.path}/` : e.path);

    // Récupérer les manifestes clés depuis raw.githubusercontent.com en parallèle
    const manifestCandidates = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod'];
    const presentManifests = manifestCandidates.filter(m => paths.includes(m));
    let syntheticContent = '';

    await Promise.all(presentManifests.map(async (mf) => {
      try {
        const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(branch)}/${mf}`;
        const mfRes = await fetch(rawUrl, { signal: AbortSignal.timeout(4000) });
        if (mfRes.ok) {
          const text = await mfRes.text();
          syntheticContent += `\n================================================\nFILE: ${mf}\n================================================\n${text}\n`;
        }
      } catch { /* ignore individual manifest error */ }
    }));

    const filesCount = entries.filter(e => e.type === 'blob').length;
    const estTokens = Math.max(1000, Math.round((repoData.size || 100) * 180));

    return {
      tree: paths.slice(0, 600).join('\n'),
      content: syntheticContent,
      summary: `Repository: ${slug}\nFiles analyzed: ${filesCount}\nEstimated tokens: ${estTokens}\nCommit: ${treeJson.sha || ''}`,
      digest_url: `https://gitingest.com/${slug}`,
      fallbackSource: 'GitHub Trees API'
    };
  } catch (err) {
    console.warn(`[GITHUB-TREE FALLBACK] Échec pour ${slug}:`, err.message);
    return null;
  }
}

export function computeAiContextFit(estimatedTokens = 0) {
  const tokens = Number(estimatedTokens) || 0;
  let tier = 'COMPACT (< 32k)';
  if (tokens > 1000000) tier = 'HYPERSCALE (> 1M — Chunking RAG requis)';
  else if (tokens > 200000) tier = 'LARGE (200k - 1M — Gemini 1M / Long Context)';
  else if (tokens > 128000) tier = 'MEDIUM-LARGE (128k - 200k)';
  else if (tokens > 32000) tier = 'STANDARD (32k - 128k — Direct Prompting)';

  return {
    estimatedTokens: tokens,
    fitsIn32k: tokens <= 32000,
    fitsIn128k: tokens <= 128000,
    fitsIn1m: tokens <= 1000000,
    recommendedTier: tier
  };
}

/**
 * Analyse le digest GitIngest (ou fallback GitHub Trees) et extrait les métriques profondes
 */
export function analyzeDigest(raw) {
  if (!raw || !raw.tree) {
    return { available: false };
  }

  const tree = raw.tree || '';
  const content = raw.content || '';
  const summary = raw.summary || '';

  // 1. Parser le résumé : fichiers et tokens
  const filesMatch = summary.match(/Files analyzed:\s*(\d+)/i);
  const tokensMatch = summary.match(/Estimated tokens:\s*([\d.]+)([kKmM]?)/i);
  const commitMatch = summary.match(/Commit:\s*([a-f0-9]+)/i);

  let tokenCount = 0;
  if (tokensMatch) {
    tokenCount = parseFloat(tokensMatch[1]);
    const suffix = (tokensMatch[2] || '').toLowerCase();
    if (suffix === 'k') tokenCount *= 1000;
    if (suffix === 'm') tokenCount *= 1000000;
  }

  // 2. Détection de fichiers critiques dans l'arbre
  const treeLines = tree.split('\n').map(l => l.trim().replace(/^[│├└─\s]+/, '')).filter(Boolean);

  const hasReadme = treeLines.some(l => /^readme/i.test(l));
  const hasLicense = treeLines.some(l => /^license/i.test(l));
  const hasDockerfile = treeLines.some(l => /^dockerfile/i.test(l));
  const hasDockerCompose = treeLines.some(l => /^docker-compose/i.test(l));
  const hasMakefile = treeLines.some(l => /^makefile/i.test(l));
  const hasCI = treeLines.some(l => /^\.github/i.test(l) || /^\.gitlab-ci/i.test(l) || /^\.circleci/i.test(l) || /^jenkinsfile/i.test(l) || /github\/workflows/i.test(l));
  const hasTests = treeLines.some(l => /^tests?\//i.test(l) || /^__tests__\//i.test(l) || /^spec\//i.test(l) || /test_.*\.py/i.test(l) || /\.test\.(js|ts|mjs)/i.test(l) || /\.spec\.(js|ts|mjs)/i.test(l));
  const hasContributing = treeLines.some(l => /^contributing/i.test(l));
  const hasChangelog = treeLines.some(l => /^changelog/i.test(l) || /^history/i.test(l));
  const hasSecurity = treeLines.some(l => /^security/i.test(l));

  // Lockfiles pour la reproductibilité des builds
  const lockfiles = [];
  if (treeLines.some(l => l === 'package-lock.json')) lockfiles.push('package-lock.json');
  if (treeLines.some(l => l === 'pnpm-lock.yaml')) lockfiles.push('pnpm-lock.yaml');
  if (treeLines.some(l => l === 'yarn.lock')) lockfiles.push('yarn.lock');
  if (treeLines.some(l => l === 'uv.lock')) lockfiles.push('uv.lock');
  if (treeLines.some(l => l === 'poetry.lock')) lockfiles.push('poetry.lock');
  if (treeLines.some(l => l === 'Cargo.lock')) lockfiles.push('Cargo.lock');
  if (treeLines.some(l => l === 'go.sum')) lockfiles.push('go.sum');

  // 3. Détection du gestionnaire de dépendances
  const hasPackageJson = treeLines.some(l => l === 'package.json');
  const hasRequirementsTxt = treeLines.some(l => /^requirements.*\.txt$/i.test(l));
  const hasPyprojectToml = treeLines.some(l => l === 'pyproject.toml');
  const hasSetupPy = treeLines.some(l => l === 'setup.py');
  const hasCargoToml = treeLines.some(l => l === 'Cargo.toml');
  const hasGoMod = treeLines.some(l => l === 'go.mod');

  // 4. Extraction des dépendances réelles, scripts & contraintes runtime
  const hasPythonFiles = treeLines.some(l => /\.py$/i.test(l));
  const hasRustFiles = treeLines.some(l => /\.rs$/i.test(l));
  const hasGoFiles = treeLines.some(l => /\.go$/i.test(l));
  const prioritizePython = hasPythonFiles && (hasRequirementsTxt || hasPyprojectToml || hasSetupPy);

  const extracted = extractManifestDetails(content, {
    hasPackageJson: prioritizePython ? false : hasPackageJson,
    hasRequirementsTxt,
    hasPyprojectToml: !hasRequirementsTxt && hasPyprojectToml,
    hasSetupPy: !hasRequirementsTxt && !hasPyprojectToml && hasSetupPy,
    hasCargoToml: hasCargoToml && (hasRustFiles || !hasPackageJson),
    hasGoMod: hasGoMod && (hasGoFiles || !hasPackageJson)
  });

  // 5. Comptage des répertoires de niveau 1
  const topDirs = treeLines.filter(l => l.endsWith('/') && !l.slice(0, -1).includes('/')).length;

  // 6. Détection de documentation riche
  const hasDocsDir = treeLines.some(l => /^docs?\//i.test(l) || /^documentation\//i.test(l));
  const hasExamples = treeLines.some(l => /^examples?\//i.test(l) || /^demo\//i.test(l) || /^samples?\//i.test(l));

  // 7. Score de maturité du projet (0-100)
  let maturityScore = 0;
  if (hasReadme) maturityScore += 10;
  if (hasLicense) maturityScore += 10;
  if (hasCI) maturityScore += 15;
  if (hasTests) maturityScore += 15;
  if (hasDockerfile) maturityScore += 10;
  if (hasContributing) maturityScore += 5;
  if (hasChangelog) maturityScore += 5;
  if (hasSecurity) maturityScore += 5;
  if (hasDocsDir) maturityScore += 10;
  if (hasExamples) maturityScore += 5;
  if (extracted.dependencies.count > 0) maturityScore += 5;
  if (topDirs >= 3 || lockfiles.length > 0) maturityScore += 5;
  maturityScore = Math.min(100, maturityScore);

  const estimatedTokens = Math.round(tokenCount);
  const digestHash = createHash('sha256')
    .update(tree + summary)
    .digest('hex');

  return {
    available: true,
    source: raw.fallbackSource || 'GitIngest API',
    commitHash: commitMatch ? commitMatch[1] : null,
    filesAnalyzed: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    estimatedTokens,
    aiContextFit: computeAiContextFit(estimatedTokens),
    digestUrl: raw.digest_url || null,
    structure: {
      topLevelDirectories: topDirs,
      totalTreeLines: treeLines.length,
      treePreview: tree.substring(0, 2000)
    },
    projectHealth: {
      hasReadme,
      hasLicense,
      hasCI,
      hasTests,
      hasDockerfile,
      hasDockerCompose,
      hasMakefile,
      hasContributing,
      hasChangelog,
      hasSecurity,
      hasDocsDir,
      hasExamples,
      hasLockfile: lockfiles.length > 0,
      lockfiles
    },
    dependencies: extracted.dependencies,
    detectedScripts: extracted.scripts,
    runtimeConstraint: extracted.runtimeConstraint,
    maturityScore,
    digestHash
  };
}

function extractFileSection(content, filenameRegexStr) {
  const regex = new RegExp(`FILE:\\s*${filenameRegexStr}\\s*\\n=+\\s*\\n([\\s\\S]*?)(?=\\n=+\\s*\\nFILE:|\\n\\(Files content|$)`, 'i');
  const match = content.match(regex);
  return match ? match[1] : null;
}

/**
 * Extraire les dépendances, scripts et contraintes runtime depuis le contenu source brut
 */
export function extractManifestDetails(content, flags) {
  const deps = { runtime: [], dev: [], count: 0, manager: 'Inconnu' };
  const scripts = {};
  let runtimeConstraint = null;

  if (!content) return { dependencies: deps, scripts, runtimeConstraint };

  const searchContent = content.substring(0, 250000);

  if (flags.hasPackageJson) {
    deps.manager = 'npm / yarn / pnpm';
    const rawPkg = extractFileSection(searchContent, 'package\\.json');
    if (rawPkg) {
      try {
        const pkg = JSON.parse(rawPkg.trim());
        deps.runtime = Object.keys(pkg.dependencies || {}).slice(0, 25);
        deps.dev = Object.keys(pkg.devDependencies || {}).slice(0, 15);
        deps.count = deps.runtime.length + deps.dev.length;
        if (pkg.scripts && typeof pkg.scripts === 'object') {
          for (const key of ['dev', 'start', 'build', 'test', 'lint']) {
            if (pkg.scripts[key]) scripts[key] = pkg.scripts[key];
          }
        }
        if (pkg.engines && pkg.engines.node) {
          runtimeConstraint = `Node.js ${pkg.engines.node}`;
        }
      } catch { /* JSON malformé */ }
    }
  } else if (flags.hasRequirementsTxt) {
    deps.manager = 'pip';
    const rawReq = extractFileSection(searchContent, 'requirements[^\\n]*\\.txt');
    if (rawReq) {
      deps.runtime = rawReq.split('\n')
        .map(l => l.trim().split(/[>=<!\[#;]/)[0].trim())
        .filter(l => l && !l.startsWith('#') && !l.startsWith('-'))
        .slice(0, 30);
      deps.count = deps.runtime.length;
    }
  } else if (flags.hasPyprojectToml) {
    deps.manager = 'pip / poetry / hatch';
    const rawPy = extractFileSection(searchContent, 'pyproject\\.toml');
    if (rawPy) {
      const pyVer = rawPy.match(/requires-python\s*=\s*"([^"]+)"/i);
      if (pyVer) runtimeConstraint = `Python ${pyVer[1]}`;

      const depBlock = rawPy.match(/dependencies\s*=\s*\[([\s\S]*?)\]/i);
      const sourceText = depBlock ? depBlock[1] : rawPy;
      const depLines = sourceText.match(/"([a-zA-Z0-9_.-]+)(?:[>=<\[~!].*)?"/g) || [];
      deps.runtime = [...new Set(depLines.map(d => d.replace(/["'>=<\[\~!].*/g, '').trim()).filter(Boolean))].slice(0, 30);
      deps.count = deps.runtime.length;
    }
  } else if (flags.hasCargoToml) {
    deps.manager = 'cargo';
    const rawCargo = extractFileSection(searchContent, 'Cargo\\.toml');
    if (rawCargo) {
      const edMatch = rawCargo.match(/edition\s*=\s*"(\d{4})"/);
      const msrvMatch = rawCargo.match(/rust-version\s*=\s*"([^"]+)"/);
      if (msrvMatch) runtimeConstraint = `Rust >= ${msrvMatch[1]}`;
      else if (edMatch) runtimeConstraint = `Rust Edition ${edMatch[1]}`;

      const depsSection = rawCargo.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/i);
      if (depsSection) {
        const crateLines = depsSection[1].split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#') && l.includes('='));
        deps.runtime = crateLines.map(l => l.split('=')[0].trim().split('.')[0]).filter(Boolean).slice(0, 30);
        deps.count = deps.runtime.length;
      }
    }
  } else if (flags.hasGoMod) {
    deps.manager = 'go modules';
    const rawGo = extractFileSection(searchContent, 'go\\.mod');
    if (rawGo) {
      const goVer = rawGo.match(/^go\s+([\d.]+)/m);
      if (goVer) runtimeConstraint = `Go >= ${goVer[1]}`;

      const reqMatches = [...rawGo.matchAll(/^\s*([a-zA-Z0-9._-]+\/[^\s]+)\s+v[\d.]+/gm)];
      deps.runtime = [...new Set(reqMatches.map(m => m[1]))].slice(0, 30);
      deps.count = deps.runtime.length;
    }
  }

  return { dependencies: deps, scripts, runtimeConstraint };
}

/**
 * Point d'entrée principal : Cache SQLite → sinon GitIngest → sinon Fallback GitHub Trees → Cache
 */
export async function deepInspect(owner, name) {
  const fullName = `${owner}/${name}`;
  const db = getDb();

  // 1. Vérifier le cache SQLite (< 24h)
  try {
    const cached = db.prepare(
      `SELECT * FROM gitingest_cache WHERE full_name = ? AND cached_at > datetime('now', '-24 hours')`
    ).get(fullName);

    if (cached) {
      console.log(`[GITINGEST] ✓ Cache hit pour ${fullName} (Score: ${cached.maturity_score})`);
      const projectHealth = JSON.parse(cached.project_health_json || '{}');
      const dependencies = JSON.parse(cached.dependencies_json || '{}');
      return {
        available: true,
        source: 'Cache SQLite (< 24h)',
        commitHash: cached.commit_hash,
        filesAnalyzed: cached.files_analyzed,
        estimatedTokens: cached.estimated_tokens,
        aiContextFit: computeAiContextFit(cached.estimated_tokens),
        digestUrl: cached.digest_url,
        structure: {
          topLevelDirectories: cached.top_level_dirs,
          totalTreeLines: cached.total_tree_lines,
          treePreview: cached.tree_preview || ''
        },
        projectHealth,
        dependencies,
        detectedScripts: projectHealth._detectedScripts || {},
        runtimeConstraint: projectHealth._runtimeConstraint || null,
        maturityScore: cached.maturity_score,
        digestHash: cached.digest_hash,
        fromCache: true
      };
    }
  } catch { /* continuer avec le fetch */ }

  // 2. Fetch depuis GitIngest, sinon Fallback GitHub Trees API
  let raw = await fetchGitIngestRaw(owner, name);
  if (!raw || !raw.tree) {
    raw = await fetchGithubTreeFallback(owner, name);
  }

  const report = analyzeDigest(raw);

  // 3. Mettre en cache si disponible
  if (report.available) {
    try {
      const healthToStore = {
        ...report.projectHealth,
        _detectedScripts: report.detectedScripts,
        _runtimeConstraint: report.runtimeConstraint
      };
      db.prepare(`
        INSERT OR REPLACE INTO gitingest_cache (
          full_name, files_analyzed, estimated_tokens, commit_hash,
          maturity_score, tree_preview, project_health_json, dependencies_json,
          digest_url, top_level_dirs, total_tree_lines, digest_hash, cached_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        fullName,
        report.filesAnalyzed,
        report.estimatedTokens,
        report.commitHash,
        report.maturityScore,
        report.structure.treePreview.substring(0, 5000),
        JSON.stringify(healthToStore),
        JSON.stringify(report.dependencies),
        report.digestUrl,
        report.structure.topLevelDirectories,
        report.structure.totalTreeLines,
        report.digestHash
      );
      console.log(`[GITINGEST] ✓ Résultat mis en cache pour ${fullName}`);
    } catch (err) {
      console.warn(`[GITINGEST] Échec mise en cache pour ${fullName}:`, err.message);
    }
  }

  return report;
}
