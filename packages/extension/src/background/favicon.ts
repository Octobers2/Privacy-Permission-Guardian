/**
 * Decides which brand a page's icon belongs to.
 *
 * A kit that copies Apple's icon onto `app1e-verify.sbs` is doing the one thing
 * `detectLookalike` cannot see: the domain string need not resemble the brand
 * at all. The icon does.
 *
 * Decoding happens here rather than in the offscreen document because a service
 * worker already has everything needed — `createImageBitmap`, `OffscreenCanvas`
 * and `getImageData` — and the icon is an image, not a document: nothing is
 * parsed as markup and nothing executes. An SVG icon will not decode in a
 * worker; that is caught and the page simply goes unhashed, which is better
 * than a second rendering path for a minority of icons.
 *
 * The arithmetic lives in `@ppg/shared/favicon`, shared with
 * `scripts/gen-favicon-hashes.ts`. If the table and the runtime hashed
 * differently, every comparison would be meaningless.
 */
import {
  dhashFromGray,
  isLowContrastIcon,
  matchFaviconHash,
  registrableDomain,
  FAVICON_HASHES,
  HASH_HEIGHT,
  HASH_WIDTH,
  type FaviconMatch,
} from '@ppg/shared';

const PREFIX = 'favicon:';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
/** A favicon is a few kilobytes. Anything that stalls is not worth a banner's delay. */
const FETCH_TIMEOUT_MS = 1_500;

interface CacheEntry {
  storedAt: number;
  /** The icon URL this was computed from, so a site changing its icon misses. */
  iconUrl: string;
  match: FaviconMatch | null;
}

const keyFor = (domain: string) => `${PREFIX}${domain}`;

/** ITU-R BT.601 luma, the usual weighting for perceptual hashing. */
function toGrayscale(pixels: Uint8ClampedArray): Uint8Array {
  const gray = new Uint8Array(pixels.length / 4);
  for (let i = 0; i < gray.length; i++) {
    const r = pixels[i * 4] ?? 0;
    const g = pixels[i * 4 + 1] ?? 0;
    const b = pixels[i * 4 + 2] ?? 0;
    const alpha = (pixels[i * 4 + 3] ?? 0) / 255;
    // Icons are mostly transparent around the mark; compositing onto white is
    // what a browser shows, and what the table was built against.
    gray[i] = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * alpha + 255 * (1 - alpha));
  }
  return gray;
}

async function hashIcon(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
    if (!response.ok) return null;

    const blob = await response.blob();
    if (blob.size === 0) return null;

    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(HASH_WIDTH, HASH_HEIGHT);
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, HASH_WIDTH, HASH_HEIGHT);

      const gray = toGrayscale(context.getImageData(0, 0, HASH_WIDTH, HASH_HEIGHT).data);
      // A blank or near-flat icon sits within a few bits of every other flat
      // icon in the table; claiming it is a brand's would be an accusation
      // built on nothing.
      if (isLowContrastIcon(gray)) return null;
      return dhashFromGray(gray, HASH_WIDTH, HASH_HEIGHT);
    } finally {
      bitmap.close();
    }
  } catch {
    // An SVG the worker cannot decode, a 404, a timeout, a site that refuses
    // the request: all of them mean "no icon evidence", none of them mean the
    // page is safe or unsafe.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The brand the page's icon belongs to, or null.
 *
 * Tries the icons in the order the page declared them, stopping at the first
 * one that decodes — a page's own `<link rel=icon>` is a better answer than the
 * `/favicon.ico` fallback, which is often a leftover.
 */
export async function faviconMatchFor(hostname: string, iconUrls: string[]): Promise<FaviconMatch | null> {
  if (iconUrls.length === 0) return null;

  const domain = registrableDomain(hostname);
  const key = keyFor(domain);
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key] as CacheEntry | undefined;
  if (entry && Date.now() - entry.storedAt <= MAX_AGE_MS && entry.iconUrl === iconUrls[0]) {
    return entry.match;
  }

  let match: FaviconMatch | null = null;
  for (const url of iconUrls) {
    const hash = await hashIcon(url);
    if (!hash) continue;
    match = matchFaviconHash(hash, FAVICON_HASHES);
    break;
  }

  await chrome.storage.local.set({
    [key]: { storedAt: Date.now(), iconUrl: iconUrls[0] ?? '', match } satisfies CacheEntry,
  });
  return match;
}

export async function clearFaviconCache(): Promise<number> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}
