/**
 * Évaluation sur Golden Set Annoté — Runbook II §9.1
 * La métrique bloquante n'est pas la F1 : c'est fpCert === 0 (zéro faux positif de certification).
 */

export const NON_SOFTWARE_CLASSES = new Set([
  'dataset', 'model_weights', 'spec', 'infra_config',
  'documentation', 'courseware', 'paperlist',
  'research_notebook', 'template', 'stub', 'unknown'
]);

export const SOFTWARE_CLASSES = new Set(['library', 'application']);

export function evaluateGolden(golden, threshold = 0.75) {
  if (!Array.isArray(golden) || golden.length === 0) {
    return {
      tp: 0, tn: 0, fp: 0, fn: 0, fpCert: 0,
      precision: 0, recall: 0, coverage: 0,
      gate: 'FAIL_EMPTY_GOLDEN_SET'
    };
  }

  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  let fpCert = 0;

  for (const g of golden) {
    const predicted = g.softwareScore >= threshold ? 'software' : 'non_software';
    const truth = SOFTWARE_CLASSES.has(g.trueClass) ? 'software' : 'non_software';

    if (predicted === 'software' && truth === 'software') tp++;
    else if (predicted === 'non_software' && truth === 'non_software') tn++;
    else if (predicted === 'non_software' && truth === 'software') fn++;
    else if (predicted === 'software' && truth === 'non_software') {
      fp++;
      if (NON_SOFTWARE_CLASSES.has(g.trueClass)) fpCert++;
    }
  }

  return {
    tp,
    tn,
    fp,
    fn,
    fpCert,
    precision: tp / Math.max(1, tp + fp),
    recall: tp / Math.max(1, tp + fn),
    coverage: (tp + tn) / golden.length,
    gate: fpCert === 0 ? 'PASS' : 'FAIL_FAIL_CLOSED_VIOLE'
  };
}
