/**
 * Gets the text of the site's terms of service, by the cheapest route that works:
 *
 *   1. the page the user is on, if it is itself the terms: the site's scripts have already run, so this is the only route
 *      that works for pages rendered on the client;
 *   2. fetch and render the linked pages in the offscreen document (no scripts run, but stylesheets apply, so text hidden
 *      with CSS is recognised and left out);
 *   3. let the site render itself in a background tab the user never sees (client-rendered pages again).
 */
import type { ExtractCurrentPageResponse, PolicyCandidatesResponse } from '../messages.ts';
import type { PolicyFailure } from '../offscreen/index.ts';
import { readInBackgroundTab } from './background-tab.ts';
import { readPolicy } from './offscreen.ts';

export interface Acquired {
  policyUrl: string;
  text: string;
  truncated: boolean;
}

export type AcquireResult = { ok: true; document: Acquired } | { ok: false; reason: string; links: string[] };

const MIN_LIVE_CHARS = 400;

/** One sentence that says what to do next, built from what was actually measured for each candidate. */
export function explainFailures(failures: PolicyFailure[]): string {
  if (failures.length === 0) return 'No terms of service were found.';
  const count = (reason: PolicyFailure['reason']) => failures.filter((f) => f.reason === reason).length;
  const n = failures.length;
  if (count('needs-javascript') > 0) {
    return `Found ${n} link${n === 1 ? '' : 's'}, but the text only appears once the site's own scripts run. A hidden tab was tried and still could not read enough (it may be behind a sign-in). Open the terms yourself and analyse from that page.`;
  }
  if (count('fetch-failed') === n) return `Found ${n} link${n === 1 ? '' : 's'}, but none could be reached. Check your connection.`;
  if (count('http-error') === n) return `Found ${n} link${n === 1 ? '' : 's'}, but every one returned an error (a sign-in wall, or the page moved).`;
  return `Found ${n} link${n === 1 ? '' : 's'}, but what came back was too short to be a terms document.`;
}

export async function acquire(tabId: number): Promise<AcquireResult> {
  let live: ExtractCurrentPageResponse | null = null;
  let candidates: PolicyCandidatesResponse = { links: [], guesses: [] };
  try {
    live = (await chrome.tabs.sendMessage(tabId, { type: 'extract-current-page' })) ?? null;
    candidates = (await chrome.tabs.sendMessage(tabId, { type: 'policy-candidates' })) ?? candidates;
  } catch {
    return { ok: false, reason: 'Could not read this page. Reload it and try again.', links: [] };
  }

  if (live?.isPolicyPage && live.text.length >= MIN_LIVE_CHARS) {
    return { ok: true, document: { policyUrl: live.policyUrl, text: live.text, truncated: live.truncated } };
  }

  const tryList = [...new Set([...candidates.links, ...candidates.guesses])];
  const read = await readPolicy(tryList);
  if (read.policy) return { ok: true, document: read.policy };

  for (const failure of read.failures.filter((f) => f.reason === 'needs-javascript').slice(0, 3)) {
    const inTab = await readInBackgroundTab(failure.url);
    if (inTab) return { ok: true, document: { policyUrl: inTab.policyUrl, text: inTab.text, truncated: inTab.truncated } };
  }
  // Nothing linked and none of the usual addresses exist: the site simply has no terms page we can find. Saying "found 8 links"
  // about addresses we only guessed would be wrong, so that case gets its own sentence.
  if (candidates.links.length === 0) {
    return { ok: false, reason: 'No terms of service were found. This page does not link to any, and the usual addresses (such as /terms) do not exist.', links: [] };
  }
  const linked = read.failures.filter((f) => candidates.links.includes(f.url));
  return { ok: false, reason: explainFailures(linked), links: candidates.links.slice(0, 5) };
}
