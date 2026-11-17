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
  const probant = Array.isArray(golden)
    && golden.length >= 200
    && golden.every(g => Boolean(g && g.annotated_by && g.arbitrated === true));

  const annotated = Array.isArray(golden)
    && golden.length > 0
    && golden.every(g => Boolean(g && g.annotated_by && g.arbitrated === true));

  if (!annotated) {
    return {
      tp: null, tn: null, fp: null, fn: null, fpCert: null,
      precision: null, recall: null, coverage: null,
      gate: 'FAIL_JEU_NON_PROBANT',
      reason: 'jeu vide, synthétique ou non arbitré'
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

  let gate;
  if (fpCert > 0) gate = 'FAIL_FAIL_CLOSED_VIOLE';
  else if (!probant) gate = 'FAIL_JEU_NON_PROBANT';
  else gate = 'PASS';

  return {
    tp,
    tn,
    fp,
    fn,
    fpCert,
    precision: tp / Math.max(1, tp + fp),
    recall: tp / Math.max(1, tp + fn),
    coverage: (tp + tn) / golden.length,
    gate
  };
}
