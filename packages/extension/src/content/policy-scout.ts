/**
 * Finds where the site's privacy policy or terms of service lives.
 *
 * Only the finding happens here. Reading the document used to as well, and it
 * was wrong twice over: a content script's `fetch` is subject to the page's
 * CSP, so sites like GitHub and Reddit blocked the request to their own privacy
 * page; and a `DOMParser` document has no browsing context, so every
 * style-based check in the sanitiser silently did nothing. Both are fixed by
 * doing the reading in the offscreen document — see `src/offscreen/index.ts`.
 *
 * Link discovery stays here because it needs the live page's DOM, which is the
 * one thing the offscreen document does not have.
 */
export const POLICY_PATTERN = /privacy|policy|terms|tos\b|legal|條款|私隱|隱私|使用者條款|服務條款/i;

/**
 * `URL.pathname` percent-encodes anything outside ASCII, so a Chinese path like
 * `/私隱政策` arrives as `/%E7%A7%81%E9%9A%B1%E6%94%BF%E7%AD%96` and never
 * matches the Chinese half of the pattern. Decoding first is what makes the
 * pattern work on the sites it was written for.
 */
function readablePath(url: URL | string): string {
  const path = typeof url === 'string' ? url : url.pathname;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Whether the page the user is on is itself a policy document. */
export function looksLikePolicyPage(
  doc: Document = document,
  pageUrl: string = location.href,
): boolean {
  let path = pageUrl;
  try {
    path = readablePath(new URL(pageUrl));
  } catch {
    /* fall back to matching the whole string */
  }
  return POLICY_PATTERN.test(path) || POLICY_PATTERN.test(doc.title ?? '');
}

/** Paths worth trying when the page links to nothing useful. */
const FALLBACK_PATHS = ['/privacy', '/privacy-policy', '/terms', '/legal/privacy', '/policies/privacy'];

/**
 * Same-site without the public suffix list.
 *
 * Pulling `tldts` in here would add roughly 250 kB to a bundle that loads on
 * every page, to answer a question that "same host, or sharing the last two
 * labels" gets right for the sites this runs on. It is what lets
 * `docs.github.com` count as GitHub's own policy while a link to an unrelated
 * domain does not.
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
    if (!POLICY_PATTERN.test(readablePath(resolved)) && !POLICY_PATTERN.test(text)) continue;

    // Footers are where these links actually live; a "terms" mention in body
    // copy is more often prose than a link to the document.
    let score = anchor.closest('footer') ? 2 : 0;
    // "Privacy policy" beats "Terms of service" — it is the document that
    // answers "what do they do with my data?".
    if (/privacy|私隱|隱私/i.test(readablePath(resolved) + text)) score += 1;

    scored.push({ url: resolved.origin + resolved.pathname, score });
  }

  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.url)
    .filter((url) => (seen.has(url) ? false : (seen.add(url), true)));
}

/**
 * Every URL worth trying, best first: links found on the page, then the paths
 * sites conventionally use when they do not link to them from here.
 */
export function policyCandidates(
  doc: Document = document,
  pageUrl: string = location.href,
): string[] {
  const found = findPolicyLinks(doc, pageUrl);

  const fallbacks: string[] = [];
  for (const path of FALLBACK_PATHS) {
    try {
      fallbacks.push(new URL(path, pageUrl).toString());
    } catch {
      /* an unparseable page url has nothing to resolve against */
    }
  }

  const seen = new Set<string>();
  return [...found, ...fallbacks].filter((url) => (seen.has(url) ? false : (seen.add(url), true)));
}
