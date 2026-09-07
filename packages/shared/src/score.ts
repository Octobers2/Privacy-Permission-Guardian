/**
 * Turns a set of policy findings into a single number.
 *
 * The model is never asked for the score. Asking it would produce a figure that
 * drifts between runs and between providers, cannot be unit tested, and cannot
 * be explained to the user beyond "the model said so". Deriving it from the
 * severities the model assigned keeps the judgement where the model is useful —
 * reading legal prose — and the arithmetic where it is not.
 */
import type { PolicyPoint, Severity } from './schemas.ts';

const SEVERITY_POINTS: Record<Severity, number> = { high: 25, medium: 12, low: 4 };

export function riskScore(points: Pick<PolicyPoint, 'severity'>[]): number {
  const total = points.reduce((sum, point) => sum + SEVERITY_POINTS[point.severity], 0);
  return Math.min(100, total);
}

export type RiskBand = 'low' | 'moderate' | 'high';

/** The band drives the badge colour and the popup's headline. */
export function riskBand(score: number): RiskBand {
  if (score >= 60) return 'high';
  if (score >= 25) return 'moderate';
  return 'low';
}

export const BAND_LABELS: Record<RiskBand, string> = {
  low: '收集有限',
  moderate: '有幾點要留意',
  high: '收集得好多',
};
