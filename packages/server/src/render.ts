/**
 * Reads a policy page that only exists after its own JavaScript has run.
 *
 * The extension can already do this itself — it opens the page in a background
 * tab the user never sees. What the server adds is that it works when the
 * browser's attempt does not, and that it costs the user's machine nothing: one
 * Chromium here serves everybody, and a summary the cache already holds never
 * reaches this file at all.
 *
 * What it gives up, and the extension deliberately keeps as a fallback:
 *
 *   - **the user's session.** A policy behind a login is readable from their
 *     browser and not from here.
 *   - **looking like a person.** A site that blocks data-centre traffic blocks
 *     this and not them.
 *
 * The text is extracted by `render-probe.ts`, which is the extension's own
 * `extractVisibleText` bundled and injected — the same defence layer 1, not a
 * second copy of it. One caveat that belongs in the threat model: the probe runs
 * in the page's own JavaScript context, so a page that has already replaced
 * `getComputedStyle` can lie to it. Layers 2 to 5 (delimiting, schema, verbatim
 * quote checking, never rendering model output as markup) are unaffected, and
 * the extension's own paths — offscreen with scripts disabled, or an isolated
 * content-script world — do not have this property.
 */
import { lookup } from 'node:dns/promises';
import { resolve as resolvePath } from 'node:path';
import { Browser } from './chromium.ts';

export interface RenderedPolicy {
  policyUrl: string;
  text: string;
  truncated: boolean;
}

/**
 * Why a candidate could not be used.
 *
 * Deliberately the same vocabulary as the extension's offscreen reader
 * (`packages/extension/src/offscreen/index.ts`) plus the two only this path can
 * produce, so the popup keeps saying *which* thing failed rather than "could
 * not read any of them".
 */
export type RenderFailureReason =
  | 'blocked-host'
  | 'fetch-failed'
  | 'http-error'
  | 'not-html'
  | 'too-short'
  | 'render-unavailable';

export interface RenderFailure {
  url: string;
  reason: RenderFailureReason;
}

export interface RenderResult {
  policy: RenderedPolicy | null;
  failures: RenderFailure[];
}

/** Injected by the tests, so nothing in `bun test` launches a browser. */
export type Renderer = (urls: string[]) => Promise<RenderResult>;

const MAX_POLICY_CHARS = 24_000;
const MIN_USEFUL_CHARS = 400;

/** Client rendering finishes some time after load; poll rather than guess. */
const SETTLE_MS = 1_200;
const RENDER_ATTEMPTS = 6;
const RENDER_INTERVAL_MS = 700;

/** One page should not be able to hold a tab, or a caller, forever. */
const PAGE_BUDGET_MS = 20_000;

/* ---------------------------------------------------------------- SSRF guard */

/**
 * Ranges that are not the public internet.
 *
 * Without this check an authenticated user turns the server into a probe of
 * whatever is on its network — a cloud metadata endpoint at 169.254.169.254, a
 * database on 10.x, the admin panel of the box it runs on — because the URL to
 * open is theirs to choose. The renderer is behind a login, which decides *who*
 * can ask; this decides *what* they can ask for.
 */
function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0/24 and 192.0.2/24
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * The eight groups of an IPv6 address, or null if it is not one.
 *
 * Expanded rather than matched as text: `::ffff:127.0.0.1` and `::ffff:7f00:1`
 * are the same address, and `new URL()` normalises the first spelling into the
 * second — so a check written against the readable form passes loopback
 * straight through.
 */
function v6Groups(value: string): number[] | null {
  let text = value;

  // A trailing dotted quad is the last two groups written in decimal.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = [dotted[1], dotted[2], dotted[3], dotted[4]].map(Number);
    if ([a, b, c, d].some((part) => part === undefined || part > 255)) return null;
    const high = ((a! << 8) | b!).toString(16);
    const low = ((c! << 8) | d!).toString(16);
    text = `${text.slice(0, dotted.index)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const gap = halves.length === 2 ? new Array(8 - head.length - tail.length).fill('0') : [];

  const groups = [...head, ...gap, ...tail].map((group) => parseInt(group || '0', 16));
  if (groups.length !== 8 || groups.some((group) => Number.isNaN(group))) return null;
  return groups;
}

function isPrivateV6(address: string): boolean {
  const groups = v6Groups(address.toLowerCase().split('%')[0] ?? '');
  if (!groups) return true; // unparseable is not a reason to allow it

  // IPv4 written as IPv6 is still IPv4 — including `::1`, which is 127.0.0.1's
  // equivalent by another route.
  if (groups.slice(0, 5).every((group) => group === 0)) {
    const [g5, g6, g7] = [groups[5]!, groups[6]!, groups[7]!];
    if (g5 === 0xffff || g5 === 0) {
      if (g5 === 0 && g6 === 0 && g7 <= 1) return true; // :: and ::1
      return isPrivateV4(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
    }
  }

  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link local fe80::/10
  return false;
}

/** Whether this URL is safe to point a browser at. Throws nothing; answers. */
export async function isPublicUrl(rawUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // Credentials in the URL are how a fetcher gets talked into authenticating to
  // something it should not be talking to at all.
  if (url.username || url.password) return false;

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || /\.(localhost|local|internal|home|lan)$/i.test(hostname)) {
    return false;
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return false;
  }
  if (addresses.length === 0) return false;

  // Every address, not just the first: a name that resolves to one public and
  // one private address is the shape of the attack, not an accident.
  return addresses.every(({ address, family }) =>
    family === 6 ? !isPrivateV6(address) : !isPrivateV4(address),
  );
}

/* ------------------------------------------------------------------ browser */

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function ensureBrowser(): Promise<Browser> {
  if (browser?.connected) return browser;
  if (launching) return launching;

  launching = Browser.launch({
    onDisconnect: () => {
      // Next request launches a new one rather than waiting on a dead socket.
      browser = null;
    },
  })
    .then((launched) => {
      browser = launched;
      return launched;
    })
    .finally(() => {
      launching = null;
    });

  return launching;
}

export function closeRenderer(): void {
  browser?.close();
  browser = null;
}

/** The probe, bundled once. Built lazily so a server that never renders pays nothing. */
let probeSource: Promise<string> | null = null;

function probe(): Promise<string> {
  probeSource ??= Bun.build({
    entrypoints: [resolvePath(import.meta.dir, 'render-probe.ts')],
    target: 'browser',
    format: 'iife',
    minify: true,
  }).then(async (built) => {
    if (!built.success) throw new Error(`could not bundle the render probe: ${built.logs.join(', ')}`);
    return built.outputs[0]!.text();
  });
  return probeSource;
}

/* ---------------------------------------------------------- one at a time-ish */

/**
 * Two tabs at once.
 *
 * A rendering tab is a whole browser page: several hundred megabytes on a heavy
 * site. The work is bursty and short, so a queue behind a small limit costs a
 * caller a second or two and keeps the server from being killed by its own
 * memory use.
 */
const MAX_CONCURRENT_TABS = 2;
let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_TABS) {
    active++;
    return;
  }
  // The slot is handed over on release rather than re-counted here, so two
  // callers waking at once cannot both decide there is room.
  await new Promise<void>((go) => waiting.push(go));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

/* ------------------------------------------------------------------ reading */

interface ProbeResult {
  text: string;
  truncated: boolean;
  scriptCount: number;
}

async function renderOne(url: string): Promise<RenderedPolicy | RenderFailure> {
  if (!(await isPublicUrl(url))) return { url, reason: 'blocked-host' };

  let instance: Browser;
  try {
    instance = await ensureBrowser();
  } catch {
    return { url, reason: 'render-unavailable' };
  }

  await acquire();
  const deadline = Date.now() + PAGE_BUDGET_MS;
  let tab: Awaited<ReturnType<Browser['openTab']>> | null = null;

  try {
    tab = await instance.openTab(url, SETTLE_MS);

    if (tab.navigationError) return { url, reason: 'fetch-failed' };
    const response = tab.mainResponse;
    if (!response) return { url, reason: 'fetch-failed' };
    if (response.status >= 400) return { url, reason: 'http-error' };
    if (response.mimeType && !response.mimeType.includes('html')) return { url, reason: 'not-html' };

    const source = await probe();

    let best: ProbeResult | null = null;
    for (let attempt = 0; attempt < RENDER_ATTEMPTS && Date.now() < deadline; attempt++) {
      // Re-injected each time: a single-page app that navigated in place has a
      // fresh JavaScript context, and the previous definition went with it.
      await tab.evaluate(source);
      const result = await tab.evaluate<ProbeResult>(`__ppgExtract(${MAX_POLICY_CHARS})`);

      // Keep the longest seen. A single-page app renders in stages, and an
      // early read catches a spinner and a cookie banner.
      if (result && (!best || result.text.length > best.text.length)) best = result;
      if (best && best.text.length >= MIN_USEFUL_CHARS && result?.text.length === best.text.length) break;

      await Bun.sleep(RENDER_INTERVAL_MS);
    }

    if (!best || best.text.length < MIN_USEFUL_CHARS) return { url, reason: 'too-short' };

    return {
      policyUrl: response.url || url,
      text: best.text,
      truncated: best.truncated,
    };
  } catch {
    return { url, reason: 'render-unavailable' };
  } finally {
    await tab?.close().catch(() => {});
    release();
  }
}

/** Tries each candidate in order and returns the first that reads like a document. */
export async function renderFirstPolicy(urls: string[]): Promise<RenderResult> {
  const failures: RenderFailure[] = [];
  for (const url of urls) {
    const result = await renderOne(url);
    if ('policyUrl' in result) return { policy: result, failures };
    failures.push(result);
  }
  return { policy: null, failures };
}
