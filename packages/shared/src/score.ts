/**
 * Turns a set of findings into a single number.
 *
 * The model is never asked for the score. Asking it would produce a figure that drifts between runs and between providers,
 * cannot be unit tested, and cannot be explained beyond "the model said so". Deriving it from the severities keeps the judgement
 * where the model is useful (reading legal prose) and the arithmetic where it is not.
 */
import type { Severity } from './schemas.ts';

const SEVERITY_POINTS: Record<Severity, number> = { high: 25, medium: 12, low: 4 };

export function riskScore(points: { severity: Severity }[]): number {
  const total = points.reduce((sum, point) => sum + SEVERITY_POINTS[point.severity], 0);
  return Math.min(100, total);
}
