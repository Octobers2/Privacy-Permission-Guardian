/**
 * What an analysis is doing and what it found, as the popup renders it.
 *
 * Types only. The analysis itself runs in the offscreen document (analyzer.ts) and reports into
 * `chrome.storage.session`, which the service worker writes and the popup reads; neither side needs the other to be awake.
 */
import type { Passage, Summary, UnfairCategory } from '@ppg/shared';

export type Stage = 'reading' | 'privacy-check' | 'checking-cache' | 'loading-model' | 'classifying' | 'sharing' | 'summarising';

export const STAGE_LABELS: Record<Stage, string> = {
  reading: 'Reading the terms…',
  'privacy-check': 'Checking the page is safe to analyse…',
  'checking-cache': 'Looking for a saved result…',
  'loading-model': 'Starting the on-device model…',
  classifying: 'Reading clause by clause…',
  sharing: 'Sharing the result…',
  summarising: 'Writing a plain-language summary…',
};

/** What happened to the result after it was computed. */
export type Sharing =
  | { status: 'shared'; id: number }
  | { status: 'already-public' }
  | { status: 'not-signed-in' }
  | { status: 'blocked'; reasons: string[] }
  | { status: 'failed'; message: string };

export interface AnalysisResult {
  policyUrl: string;
  domain: string;
  textHash: string;
  model: { id: string; version: string };
  analyzedAt: string;
  /** Where the findings came from: this computer, or the shared public cache. */
  source: 'this-device' | 'community';
  passageCount: number;
  /** The clauses the classifier flagged as potentially unfair, in reading order. */
  flagged: Passage[];
  categories: Partial<Record<UnfairCategory, number>>;
  /** True when the document was cut short before it was read. */
  truncated: boolean;
  sharing: Sharing;
  /** Set when the page looks like it shows personal data; nothing about it was shared or summarised. */
  personal: { reasons: string[] } | null;
  summary: Summary | null;
  summaryError: string | null;
  /** Set for a result looked up from the public cache: how many documents the site has there, and where to see them. */
  site?: { documents: number; url: string };
}

export type AnalysisState =
  | { status: 'idle'; domain: string }
  | { status: 'needs-setup' }
  | { status: 'working'; domain: string; stage: Stage; done: number; total: number; detail?: string; flagged: Passage[] }
  | { status: 'ready'; domain: string; result: AnalysisResult }
  /** Not a failure: plenty of sites have no findable terms, and saying so beats inventing an answer. */
  | { status: 'unavailable'; domain: string; reason: string; links?: string[] }
  | { status: 'error'; domain: string; message: string; /** The first lines of the stack, for a bug report. */ detail?: string };

export function countCategories(passages: Pick<Passage, 'category'>[]): Partial<Record<UnfairCategory, number>> {
  const counts: Partial<Record<UnfairCategory, number>> = {};
  for (const p of passages) counts[p.category] = (counts[p.category] ?? 0) + 1;
  return counts;
}
