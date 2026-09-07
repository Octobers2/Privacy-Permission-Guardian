/**
 * Finds and reads the site's privacy policy or terms of service.
 *
 * The fetch happens here rather than in the service worker or on the managed
 * backend, and that is a deliberate choice: a server-side fetch runs into
 * Cloudflare checks, bot blocking and geographic redirects, and would often
 * retrieve a different page from the one the user is actually being asked to
 * agree to. Fetching from the content script uses the user's own session, so
 * the text analysed is the text they would see.
 */
import { extractVisibleText, pickMainContent } from '@ppg/shared/sanitize';

const POLICY_PATTERN = /privacy|policy|terms|tos\b|legal|條款|私隱|隱私|使用者條款|服務條款/i;

/** Paths worth trying when the page links to nothing useful. */
const FALLBACK_PATHS = ['/privacy', '/privacy-policy', '/terms', '/legal/privacy', '/policies/privacy'];

const MAX_POLICY_CHARS = 24_000;

/**
 * Same-site without the public suffix list.
 *
 * Pulling `tldts` in here would add roughly 250 kB to a bundle that loads on
 * every page, to answer a question that "same host, or sharing the last two
 * labels" gets right for the sites this runs on.
 */
function looksSameSite(a: string, b: string): boolean {
  if (a === b) return true;
  const tail = (host: string) => host.split('.').slice(-2).join('.');
  return tail(a) === tail(b);
}

/** Candidate policy URLs on this page, footer links first. */
export function findPolicyLinks(doc: Document, pageUrl: string): string[] {
  const pageHost = (() => {
    try {
      return new URL(pageUrl).hostname;
    } catch {
      return '';
    }
  })();

  const scored: { url: string; score: number }[] = [];

  for (const anchor of doc.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(resolved.protocol)) continue;
    if (!looksSameSite(resolved.hostname, pageHost)) continue;

    const text = (anchor.textContent ?? '').trim();
    if (!POLICY_PATTERN.test(resolved.pathname) && !POLICY_PATTERN.test(text)) continue;

    // Footers are where these links actually live; a "terms" mention in body
    // copy is more often prose than a link to the document.
    let score = anchor.closest('footer') ? 2 : 0;
    // "Privacy policy" beats "Terms of service" — it is the document that
    // answers "what do they do with my data?".
    if (/privacy|私隱|隱私/i.test(resolved.pathname + text)) score += 1;

    scored.push({ url: resolved.origin + resolved.pathname, score });
  }

  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.url)
    .filter((url) => (seen.has(url) ? false : (seen.add(url), true)));
}

export interface PolicyDocument {
  policyUrl: string;
  text: string;
  truncated: boolean;
}

async function readPolicyAt(url: string): Promise<PolicyDocument | null> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'include', redirect: 'follow' });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  if (!(response.headers.get('content-type') ?? '').includes('html')) return null;

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const { text, truncated } = extractVisibleText(pickMainContent(doc), MAX_POLICY_CHARS);

  // A "policy page" of two sentences is a cookie wall or a redirect stub.
  if (text.length < 400) return null;

  return { policyUrl: response.url || url, text, truncated };
}

/**
 * Returns the site's policy text, or null when there is nothing to read.
 *
 * Null is a real answer here and is shown as "搵唔到條款" rather than being
 * papered over: summarising a page that turned out to be a cookie banner would
 * be worse than admitting the document could not be found.
 */
export async function scoutPolicy(
  doc: Document = document,
  pageUrl: string = location.href,
): Promise<PolicyDocument | null> {
  const candidates = findPolicyLinks(doc, pageUrl);

  for (const url of candidates.slice(0, 3)) {
    const found = await readPolicyAt(url);
    if (found) return found;
  }

  for (const path of FALLBACK_PATHS) {
    let url: string;
    try {
      url = new URL(path, pageUrl).toString();
    } catch {
      continue;
    }
    if (candidates.includes(url)) continue;
    const found = await readPolicyAt(url);
    if (found) return found;
  }

  return null;
}
