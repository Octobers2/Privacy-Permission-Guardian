/**
 * Page-level phishing signals: what the page ships data to, what its icon
 * claims to be, and whether it is fighting DevTools.
 *
 * `rules.ts` scores one *form*. These three things are properties of the
 * *page*, and a kit that collects credentials from loose `contenteditable`
 * divs has no form for the form rules to score at all.
 *
 * This module is a leaf on purpose. It is imported by the content script,
 * which runs on every page the user visits and is held to a 60 kB budget by
 * `eval/bundle-budget.ts`, so it must not reach for `domain.ts` (the public
 * suffix list, ~250 kB) or zod. It carries pattern ids and nothing else: the
 * points and the Cantonese reason strings live in `rules.ts`, in the worker,
 * the same split `FormAssessRequest.ruleHits` already uses.
 *
 * Everything here is a read-only walk over a `Document`, so `linkedom` can run
 * it over fixture HTML in `eval/run-rules-eval.ts` and the harness measures the
 * same code the browser runs.
 */

export interface PageSignals {
  /** Icons the page declares, absolute, most specific first. */
  iconUrls: string[];
  /**
   * Hosts named by script URLs and by URL literals inside script text.
   *
   * Form actions are not in here. Where a form posts is already
   * `cross_origin_action`, and listing it again would score one observation
   * twice.
   */
  referencedHosts: string[];
  /** Hosts a fetch / XHR / beacon actually went to. Runtime only — empty under linkedom. */
  sendingHosts: string[];
  /** Matched ids from `EXFIL_SINK_PATTERNS`. */
  exfilSinks: string[];
  /** Matched ids from `DEVTOOLS_BLOCK_PATTERNS`. */
  devtoolsBlocks: string[];
}

export const EMPTY_PAGE_SIGNALS: PageSignals = {
  iconUrls: [],
  referencedHosts: [],
  sendingHosts: [],
  exfilSinks: [],
  devtoolsBlocks: [],
};

export interface SignalPattern {
  id: string;
  pattern: RegExp;
}

/**
 * Destinations that exist to receive stolen data.
 *
 * These are matched against raw URL and script text rather than against a
 * parsed hostname, which is what lets a defused fixture keep the signal: the
 * fixture sanitiser rewrites a remote reference to
 * `https://sink.invalid/api.telegram.org/bot…`, and the substring survives.
 */
export const EXFIL_SINK_PATTERNS: SignalPattern[] = [
  { id: 'telegram_bot_api', pattern: /api\.telegram\.org\/bot/i },
  // A Telegram bot token is a shared secret. Its presence in page source means
  // the page is the bot's client, which no legitimate site has a reason to be.
  // No leading `\b`: the token's first digit follows the `t` of `/bot`, and
  // between two word characters there is no boundary to anchor to.
  { id: 'telegram_bot_token', pattern: /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/ },
  { id: 'discord_webhook', pattern: /discord(?:app)?\.com\/api\/webhooks\//i },
  { id: 'slack_webhook', pattern: /hooks\.slack\.com\/services\//i },
  {
    id: 'form_relay',
    pattern:
      /\b(?:formspree\.io|formsubmit\.co|getform\.io|web3forms\.com|herotofu\.com|formcarry\.com|usebasin\.com|staticforms\.xyz)\b/i,
  },
  {
    id: 'request_bin',
    pattern: /\b(?:webhook\.site|requestbin\.[a-z]{2,}|pipedream\.net|beeceptor\.com|ngrok(?:-free)?\.(?:io|app|dev))\b/i,
  },
  {
    id: 'paste_sink',
    pattern: /\b(?:pastebin\.com\/api|hastebin\.com\/documents|termbin\.com|0x0\.st)\b/i,
  },
];

/**
 * Techniques for keeping a reader out of DevTools.
 *
 * Detection is static: the text of the page's scripts is read, never run, and
 * nothing is dispatched at the page. An active probe — synthesising an F12
 * keydown and checking `defaultPrevented` — would see handlers registered by
 * external scripts too, but it executes the page's own code, which is the one
 * thing `docs/architecture.md` says this extension does not do to a page it is
 * only supposed to be looking at.
 *
 * The distance bounds (`{0,120}`) matter: `debugger` on its own is a leftover
 * in plenty of shipped bundles. `debugger` next to `setInterval` is a trap.
 */
export const DEVTOOLS_BLOCK_PATTERNS: SignalPattern[] = [
  {
    id: 'debugger_loop',
    pattern:
      /\bdebugger\b[\s\S]{0,120}?(?:setInterval|setTimeout|requestAnimationFrame)|(?:setInterval|setTimeout|requestAnimationFrame)\s*\([\s\S]{0,120}?\bdebugger\b/,
  },
  {
    id: 'devtools_key_block',
    pattern:
      /(?:keydown|keyup|onkeydown)[\s\S]{0,200}?(?:(?:keyCode|which)\s*[=!]==?\s*123|['"]F12['"])|shiftKey[\s\S]{0,80}?(?:keyCode|which)\s*[=!]==?\s*(?:73|74|67)|ctrlKey[\s\S]{0,80}?(?:keyCode|which)\s*[=!]==?\s*85/i,
  },
  {
    id: 'devtools_detect_lib',
    pattern: /\b(?:disable-?devtool|devtools?-?detector|console-ban|DisableDevtool)\b/i,
  },
  {
    id: 'devtools_size_probe',
    // `window.outerWidth - window.innerWidth > 160` is how this is always
    // written, so the receiver in the middle has to be allowed for.
    pattern: /(?:outerWidth|outerHeight)\s*-\s*(?:[A-Za-z_$][\w$]*\.)?(?:innerWidth|innerHeight)\s*[<>]/i,
  },
  {
    id: 'console_suppression',
    pattern:
      /console\.clear\s*\(\s*\)[\s\S]{0,80}?(?:setInterval|setTimeout)|(?:setInterval|setTimeout)\s*\([\s\S]{0,80}?console\.clear/i,
  },
  {
    id: 'contextmenu_block',
    pattern: /addEventListener\s*\(\s*['"](?:contextmenu|selectstart|dragstart)['"]|oncontextmenu\s*=/i,
  },
];

/* ------------------------------------------------------------- collection */

/** Script text is scanned, not executed; a page can still carry megabytes of it. */
const MAX_SCRIPT_CHARS = 300_000;
/** Enough to characterise a page. A tracker-heavy news site has dozens. */
const MAX_HOSTS = 50;

/** Script types whose body is code. `application/ld+json` and friends are data. */
const CODE_SCRIPT_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'module',
  'text/babel',
  'application/ecmascript',
]);

/** Absolute http(s) URLs written as literals inside script text. */
const URL_LITERAL = /https?:\/\/[^\s'"`<>\\)]+/gi;

function hostOf(url: string, base: string): string | null {
  try {
    const parsed = new URL(url, base);
    return /^https?:$/.test(parsed.protocol) ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The text of every script the page carries.
 *
 * A defused fixture keeps its scripts as `type="text/plain"` with a marker
 * attribute — the browser never runs them, but the exfil URL and the
 * `debugger` loop are still there to be read. Deleting them, which is what the
 * sanitiser used to do, would have stripped the evidence for exactly these
 * rules out of every collected sample.
 */
function scriptTexts(doc: Document): string[] {
  const texts: string[] = [];
  let budget = MAX_SCRIPT_CHARS;

  for (const script of doc.querySelectorAll('script')) {
    if (budget <= 0) break;
    const type = (script.getAttribute('type') ?? '').toLowerCase().trim();
    const defused = script.getAttribute('data-ppg-defused') !== null;
    if (!defused && !CODE_SCRIPT_TYPES.has(type)) continue;

    const text = script.textContent ?? '';
    if (!text) continue;
    texts.push(text.slice(0, budget));
    budget -= text.length;
  }

  return texts;
}

function iconUrlsOf(doc: Document, pageUrl: string): string[] {
  const urls: string[] = [];

  for (const link of doc.querySelectorAll('link[rel]')) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    if (!/\b(?:icon|shortcut|apple-touch-icon|mask-icon)\b/.test(rel)) continue;
    const href = link.getAttribute('href');
    if (!href) continue;
    try {
      const resolved = new URL(href, pageUrl);
      if (/^https?:$/.test(resolved.protocol)) urls.push(resolved.href);
    } catch {
      /* a malformed href is not an icon */
    }
  }

  // Every site has one whether it declares it or not, and a kit that copied a
  // brand's icon usually copied it to exactly this path.
  try {
    urls.push(new URL('/favicon.ico', pageUrl).href);
  } catch {
    /* an unparseable page URL has no default icon either */
  }

  return [...new Set(urls)];
}

/**
 * Reads the page's outgoing references, its icons, and the two pattern
 * families, in one pass. Never mutates the document.
 */
export function collectPageSignals(doc: Document, pageUrl: string): PageSignals {
  const texts = scriptTexts(doc);
  const hosts = new Set<string>();
  const urlsToMatch: string[] = [];

  for (const script of doc.querySelectorAll('script[src]')) {
    const src = script.getAttribute('src');
    if (!src) continue;
    urlsToMatch.push(src);
    const host = hostOf(src, pageUrl);
    if (host) hosts.add(host);
  }

  // Matched for sinks, but deliberately not added to `referencedHosts`: a form
  // posting off-origin is already `cross_origin_action`, and counting the same
  // observation twice inflates the score without adding anything to it.
  for (const form of doc.querySelectorAll('form[action]')) {
    const action = form.getAttribute('action');
    if (action) urlsToMatch.push(action);
  }

  for (const text of texts) {
    for (const [literal] of text.matchAll(URL_LITERAL)) {
      const host = hostOf(literal, pageUrl);
      if (host) hosts.add(host);
      if (hosts.size > MAX_HOSTS) break;
    }
  }

  // One haystack: a sink named in a script URL, a form action or a string
  // literal is the same finding, and the patterns are written to match a raw
  // URL rather than a parsed host precisely so this can be one search.
  const haystack = [...urlsToMatch, ...texts].join('\n');

  const exfilSinks = EXFIL_SINK_PATTERNS.filter(({ pattern }) => pattern.test(haystack)).map((p) => p.id);
  const devtoolsBlocks = DEVTOOLS_BLOCK_PATTERNS.filter(({ pattern }) => pattern.test(haystack)).map((p) => p.id);

  // The no-right-click trio is usually written as an attribute rather than as a
  // listener, and an attribute survives the fixture sanitiser only on a page we
  // wrote ourselves — on a collected one the handlers are stripped, which is
  // why this signal is worth almost nothing on its own.
  if (!devtoolsBlocks.includes('contextmenu_block')) {
    const blocker = doc.querySelector('[oncontextmenu], [onselectstart], [ondragstart]');
    if (blocker) devtoolsBlocks.push('contextmenu_block');
  }

  return {
    iconUrls: iconUrlsOf(doc, pageUrl),
    referencedHosts: [...hosts].slice(0, MAX_HOSTS),
    sendingHosts: [],
    exfilSinks,
    devtoolsBlocks,
  };
}

/**
 * Whether these signals could produce a finding on a page with no form.
 *
 * Referenced hosts alone cannot: every page on the web loads something from
 * somewhere, and the rules that read the host list all require a form asking
 * for something sensitive. This is what lets the content script skip the round
 * trip to the worker on an ordinary page, which is where the extension spends
 * almost all of its life.
 */
export function hasReportableSignals(signals: PageSignals): boolean {
  return signals.exfilSinks.length > 0 || signals.devtoolsBlocks.length > 0;
}
