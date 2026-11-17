import { Evidence } from './evidence.mjs';

/**
 * Recettes d'Exécution par Écosystème — Runbook II §8.1
 * Un build qui réussit ne suffit pas : le niveau 4 (EXECUTED) exige
 * isolation >= 70 ET instrumentation active ET build à froid exit === 0.
 */

export const RECIPES = Object.freeze({
  py: { install: 'uv pip install -e .', build: null, test: 'pytest -q', importCmd: 'python -c "import ${pkg}"' },
  js: { install: 'npm ci --ignore-scripts=true', build: 'npm run build --if-present', test: 'npm test --if-present', importCmd: 'node -e "import(\'./index.js\')"' },
  rs: { install: null, build: 'cargo build --locked', test: 'cargo test --locked', importCmd: null },
  go: { install: null, build: 'go build ./...', test: 'go test ./...', importCmd: null },
  java: { install: null, build: './gradlew build -x test', test: './gradlew test', importCmd: null }
});

export function executionVerdict(run) {
  const isolatedAndObserved = Boolean(
    run &&
    Number(run.isolation ?? 0) >= 70 &&
    run.instrumented === true &&
    run.buildExit === 0
  );

  return {
    build: run?.buildExit === 0 ? 'ok' : (run?.buildExit === null || run?.buildExit === undefined ? 'non_tente' : 'echec'),
    tests: run?.testsTotal ? `${run.testsPassed || 0}/${run.testsTotal}` : 'non_tente',
    importStatus: run?.importExit === 0 ? 'ok' : 'non_tente',
    evidenceLevel: isolatedAndObserved ? Evidence.EXECUTED : Evidence.OSV_QUERIED
  };
}
