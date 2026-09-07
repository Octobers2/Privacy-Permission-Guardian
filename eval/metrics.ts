/**
 * Confusion matrix and the numbers derived from it.
 *
 * Positive means "this is phishing". The extension only makes that claim with a
 * `danger` verdict, so that is what counts as a positive prediction; `caution`
 * asks the user to check, which is not the same assertion.
 */
export interface Confusion {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
}

export interface Metrics extends Confusion {
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  /** The number that decides whether people keep the extension installed. */
  falsePositiveRate: number;
}

export function confusionOf(results: { actualPhishing: boolean; predictedPhishing: boolean }[]): Confusion {
  const matrix: Confusion = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
  for (const { actualPhishing, predictedPhishing } of results) {
    if (actualPhishing && predictedPhishing) matrix.truePositive++;
    else if (!actualPhishing && predictedPhishing) matrix.falsePositive++;
    else if (!actualPhishing && !predictedPhishing) matrix.trueNegative++;
    else matrix.falseNegative++;
  }
  return matrix;
}

const ratio = (numerator: number, denominator: number) => (denominator === 0 ? 0 : numerator / denominator);

export function metricsOf(matrix: Confusion): Metrics {
  const precision = ratio(matrix.truePositive, matrix.truePositive + matrix.falsePositive);
  const recall = ratio(matrix.truePositive, matrix.truePositive + matrix.falseNegative);
  return {
    ...matrix,
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    accuracy: ratio(
      matrix.truePositive + matrix.trueNegative,
      matrix.truePositive + matrix.trueNegative + matrix.falsePositive + matrix.falseNegative,
    ),
    falsePositiveRate: ratio(matrix.falsePositive, matrix.falsePositive + matrix.trueNegative),
  };
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function formatMetrics(label: string, metrics: Metrics): string {
  return [
    `${label}`,
    `  confusion   TP ${metrics.truePositive}  FP ${metrics.falsePositive}  TN ${metrics.trueNegative}  FN ${metrics.falseNegative}`,
    `  precision   ${percent(metrics.precision)}`,
    `  recall      ${percent(metrics.recall)}`,
    `  f1          ${percent(metrics.f1)}`,
    `  accuracy    ${percent(metrics.accuracy)}`,
    `  false pos.  ${percent(metrics.falsePositiveRate)}`,
  ].join('\n');
}

/** A markdown table, for pasting straight into docs/evaluation.md. */
export function markdownTable(rows: { arm: string; metrics: Metrics }[]): string {
  const header = '| Arm | TP | FP | TN | FN | Precision | Recall | F1 | FP rate |';
  const divider = '|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const body = rows.map(
    ({ arm, metrics: m }) =>
      `| ${arm} | ${m.truePositive} | ${m.falsePositive} | ${m.trueNegative} | ${m.falseNegative} ` +
      `| ${percent(m.precision)} | ${percent(m.recall)} | ${percent(m.f1)} | ${percent(m.falsePositiveRate)} |`,
  );
  return [header, divider, ...body].join('\n');
}
