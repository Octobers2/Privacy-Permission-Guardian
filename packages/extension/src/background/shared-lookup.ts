/**
 * Shared-only mode: the answer comes from the public cache, and nothing is read or classified on this device.
 *
 * The one thing that leaves the browser is the registrable domain of the site being looked up (`/api/v1/sites/<domain>`), and
 * only for public sites. No page text, no full address, no account.
 */
import { similarForResult } from '../analysis/similar.ts';
import { othersFoundNoTerms } from './missing-terms.ts';
import { isPublicHostname, type ResultView } from '@ppg/shared';
import type { AnalysisResult, AnalysisState } from '../analysis/state.ts';

const TIMEOUT_MS = 8_000;
const TERMS_LIKE = /terms|tos|conditions|eula|legal|agreement|user-agreement/i;

/** An address with the parts that vary between visits removed, so two spellings of one page compare equal. */
export function addressKey(raw: string): string | null {
  try {
    const url = new URL(raw);
    return `${url.hostname.replace(/^www\./, '').toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * Which of a site's documents to show. The popup shows one, so prefer the one the page itself points at; then one that looks
 * like terms rather than a privacy policy; then the newest.
 */
export function pickDocument(documents: ResultView[], hints: string[]): ResultView | null {
  if (documents.length === 0) return null;
  const byKey = new Map(documents.map((d) => [addressKey(d.url), d]));
  for (const hint of hints) {
    const hit = byKey.get(addressKey(hint));
    if (hit) return hit;
  }
  const newest = (a: ResultView, b: ResultView) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  const terms = documents.filter((d) => TERMS_LIKE.test(new URL(d.url).pathname)).sort(newest);
  return terms[0] ?? [...documents].sort(newest)[0]!;
}

export interface LookupDeps {
  serverUrl: string;
  domain: string;
  /** Addresses the page itself offers as its terms (links on it, or the page, if it is one), best first. */
  hints: string[];
  fetch?: typeof fetch;
}

export async function lookupShared({ serverUrl, domain, hints, fetch: fetchImpl = fetch }: LookupDeps): Promise<AnalysisState> {
  if (!isPublicHostname(domain)) {
    return { status: 'unavailable', domain, reason: 'This is not a public website, so there is nothing to look up.' };
  }
  let response: Response;
  try {
    response = await fetchImpl(`${serverUrl}/api/v1/sites/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { status: 'error', domain, message: `Could not reach the results server at ${serverUrl}. Check your connection, or the server address in the settings.` };
  }
  if (response.status === 404) {
    // Nobody has shared a result; has anyone said the site has no terms at all? (A domain-only request, like the one above.)
    const others = await othersFoundNoTerms({ serverUrl, domain, fetch: fetchImpl });
    return {
      status: 'unavailable',
      domain,
      ...(others ? { noTerms: { canReport: false, tried: [], others } } : {}),
      reason:
        'Nobody has shared a result for this site in the last 30 days. This browser only looks up shared results, so it cannot read the terms itself. Results appear once someone with an on-device model reads them.',
    };
  }
  if (!response.ok) return { status: 'error', domain, message: `The results server answered ${response.status}. Try again in a moment.` };

  const body = (await response.json().catch(() => null)) as { documents?: ResultView[] } | null;
  const documents = Array.isArray(body?.documents) ? body!.documents : [];
  const doc = pickDocument(documents, hints);
  if (!doc) return { status: 'unavailable', domain, reason: 'The results server has nothing for this site.' };

  const similar = doc.passages.length ? await similarForResult(serverUrl, doc.id, fetchImpl) : null;
  const result: AnalysisResult = {
    policyUrl: doc.url,
    domain,
    textHash: doc.textHash,
    model: doc.model,
    analyzedAt: doc.createdAt,
    source: 'community',
    passageCount: doc.passageCount,
    flagged: doc.passages,
    money: doc.money ?? [],
    ...(similar ? { similar } : {}),
    categories: doc.categories,
    truncated: false,
    sharing: { status: 'already-public' },
    personal: null,
    summary: null,
    summaryError: null,
    site: { documents: documents.length, url: `${serverUrl}/site/${encodeURIComponent(domain)}` },
  };
  return { status: 'ready', domain, result };
}
