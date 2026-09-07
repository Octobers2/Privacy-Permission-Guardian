/**
 * Post-processing for a policy summary.
 *
 * Runs identically on both paths — the managed backend and the service worker
 * talking straight to the user's endpoint — because it is where the model's
 * output stops being a suggestion and becomes something shown to a person.
 */
import { isVerbatim } from './sanitize.ts';
import { riskScore } from './score.ts';
import type { PolicyPoint, PolicySummary, PolicySummaryResponse } from './schemas.ts';

export interface FinaliseInput {
  domain: string;
  policyUrl: string;
  /** The exact text the model was given; quotes are checked against this. */
  sourceText: string;
  truncated: boolean;
  promptVersion: string;
  generatedAt: string;
}

/** sha256 as lowercase hex. Available in browsers, service workers and Bun. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface FinalisedSummary {
  summary: PolicySummary;
  /** The points that failed the verbatim check, kept for the injection evaluation. */
  dropped: PolicyPoint[];
}

/**
 * Verifies every quote against the source and scores what survives.
 *
 * Dropping individual points rather than rejecting the whole response is
 * deliberate: a model that hallucinated one clause usually got the other four
 * right, and throwing everything away would leave the user with nothing. But an
 * unverifiable quote is never shown — that check is the defence against a
 * hidden instruction persuading the model to report a clause the document does
 * not contain.
 */
export function finalisePolicySummary(
  response: PolicySummaryResponse,
  input: FinaliseInput,
): FinalisedSummary {
  const kept: PolicyPoint[] = [];
  const dropped: PolicyPoint[] = [];

  for (const point of response.points) {
    // A manipulation attempt is reported against text that was already removed
    // by the sanitiser in the common case, so it is exempt from the check —
    // otherwise the one finding we most want to surface is the one that always
    // gets dropped.
    const exempt = point.category === 'manipulation_attempt';
    if (exempt || isVerbatim(point.quote, input.sourceText)) kept.push(point);
    else dropped.push(point);
  }

  return {
    summary: {
      domain: input.domain,
      policyUrl: input.policyUrl,
      truncated: input.truncated,
      riskScore: riskScore(kept),
      points: kept,
      droppedPoints: dropped.length,
      promptVersion: input.promptVersion,
      generatedAt: input.generatedAt,
    },
    dropped,
  };
}
