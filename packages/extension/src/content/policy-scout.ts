/**
 * Finds where the site's terms of service live.
 *
 * Terms, not privacy policies: the on-device classifier was trained on terms-of-service clauses (arbitration,
 * limitation of liability, unilateral changes …) and is not validated on privacy policies, so a privacy page is not a
 * candidate. Only the finding happens here. Reading the document needs an extension context (a content script's `fetch`
 * is governed by the page's CSP) and a rendering engine (a `DOMParser` document resolves no styles), which the
 * offscreen document provides; see `src/offscreen/index.ts`. Link discovery stays here because it needs the live DOM.
 */
export const TERMS_PATTERN =
  /terms|tos\b|(?:general|standard|website|site|use|service|sale|legal)\s*(?:&|and)?\s*conditions|conditions\s+(?:of|for)\s+(?:use|service|sale|access)|user.?agreement|end.?user|eula|service.?agreement|條款|使用者條款|服務條款|使用條款/i;

/**
 * Pages that do the job of terms without being called that: a government or institutional site often has only a "Disclaimer"
 * or "Important Notices" page, which carries the same kinds of clause (what the provider will not answer for, which law applies).
 * They are tried only after every link that says "terms".
 */
export const LEGAL_NOTICE_PATTERN = /disclaimer|legal.?notices?|important.?notices?|notice.?of.?use|免責|法律聲明|重要告示|重要事項/i;

/** Privacy and cookie policies. Not read by the classifier, but a site that links one has plainly published something. */
export const PRIVACY_PATTERN = /privacy|data.?protection|cookie.?(?:policy|notice|statement)|personal.?data|私隱|隱私|個人資料|私穩/i;

const matchesAny = (text: string) => TERMS_PATTERN.test(text) || LEGAL_NOTICE_PATTERN.test(text);

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

/** Whether the page links to anything that reads like terms, a legal notice or a privacy policy. */
export function hasPolicyLink(doc: Document = document, pageUrl: string = location.href): boolean {
  for (const a of doc.querySelectorAll('a[href]')) {
    let path = '';
    try {
      path = readablePath(new URL(a.getAttribute('href') ?? '', pageUrl));
    } catch {
      /* an unparseable href has no path to match */
    }
    const label = (a.textContent ?? '').slice(0, 120);
    if (matchesAny(path) || matchesAny(label) || PRIVACY_PATTERN.test(path) || PRIVACY_PATTERN.test(label)) return true;
  }
  return false;
}

/** Whether the page the user is on is itself a terms-of-service document. */
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
  return matchesAny(path) || matchesAny(doc.title ?? '');
}

/** Paths worth trying when the page links to nothing useful. */
const FALLBACK_PATHS = ['/terms', '/terms-of-service', '/terms-of-use', '/tos', '/legal/terms', '/policies/terms', '/terms-and-conditions', '/legal'];

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

/** Candidate terms-of-service URLs on this page, footer links first. */
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
    // The link's own words, including the ones a person never sees but a screen reader does.
    const label = `${text} ${anchor.getAttribute('title') ?? ''} ${anchor.getAttribute('aria-label') ?? ''}`;
    const path = readablePath(resolved);
    const isTerms = TERMS_PATTERN.test(path) || TERMS_PATTERN.test(label);
    if (!isTerms && !LEGAL_NOTICE_PATTERN.test(path) && !LEGAL_NOTICE_PATTERN.test(label)) continue;

    // Footers are where these links actually live; a "terms" mention in body copy is more often prose than a link.
    // A link whose address says "terms" beats one that only says so in its text ("Legal" -> /legal-center is a weaker guess),
    // and a link that is only a legal notice ("Disclaimer") ranks below every link that says "terms".
    let score = anchor.closest('footer, [role=contentinfo], #footer, .footer') ? 2 : 0;
    if (TERMS_PATTERN.test(path)) score += 1;
    if (!isTerms) score -= 5;

    scored.push({ url: resolved.origin + resolved.pathname, score });
  }

  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.url)
    .filter((url) => (seen.has(url) ? false : (seen.add(url), true)));
}

/** Conventional addresses, for sites that do not link their terms from the page the user is on. */
export function guessedPaths(pageUrl: string): string[] {
  const guesses: string[] = [];
  for (const path of FALLBACK_PATHS) {
    try {
      guesses.push(new URL(path, pageUrl).toString());
    } catch {
      /* an unparseable page url has nothing to resolve against */
    }
  }
  return guesses;
}

/**
 * Every URL worth trying, best first: links found on the page, then the conventional paths. The worker asks for the two
 * separately (it explains a failure differently when the page itself linked to terms), so this is the merged view.
 */
export function policyCandidates(doc: Document = document, pageUrl: string = location.href): string[] {
  const seen = new Set<string>();
  return [...findPolicyLinks(doc, pageUrl), ...guessedPaths(pageUrl)].filter((url) => (seen.has(url) ? false : (seen.add(url), true)));
}
