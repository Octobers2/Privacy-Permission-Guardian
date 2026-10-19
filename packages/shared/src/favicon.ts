/**
 * Perceptual hashing for favicons, so "the icon is Apple's but the domain is
 * not" becomes a number.
 *
 * The algorithm is dHash: reduce the icon to a 9x8 grayscale grid and record,
 * for each row, whether each pixel is brighter than the one to its right. That
 * is 64 comparisons, one 64-bit hash, and it survives the rescaling and
 * recompression a kit does when it copies a brand's icon — which an exact byte
 * or cryptographic hash would not.
 *
 * Only the arithmetic lives here. Turning an image into a grayscale grid needs
 * a decoder, which is `OffscreenCanvas` in the service worker
 * (`background/favicon.ts`) and the CDP Chromium in
 * `scripts/gen-favicon-hashes.ts`. Both inject *this* function, so the hash
 * that goes into the table and the hash computed at runtime cannot drift apart.
 */

/** One brand's icons. Several because a site's `<link rel=icon>` and its `/favicon.ico` often differ. */
export interface FaviconHashEntry {
  domain: string;
  hashes: string[];
}

export interface FaviconMatch {
  domain: string;
  distance: number;
}

/** The grid dHash wants: one column wider than tall, so each row yields 8 comparisons. */
export const HASH_WIDTH = 9;
export const HASH_HEIGHT = 8;

/**
 * Hamming distance at or below which two icons are called the same icon.
 *
 * 6 of 64 bits. Tightening this loses re-compressed copies; loosening it starts
 * matching any two icons that are a dark blob on a light square.
 */
export const DEFAULT_MAX_DISTANCE = 6;

/**
 * A 64-bit dHash of a `width` x `height` grayscale grid, as 16 hex characters.
 *
 * Throws on a grid of the wrong size rather than returning a hash that means
 * nothing — a caller that mis-sized its canvas would otherwise poison the table.
 */
export function dhashFromGray(gray: ArrayLike<number>, width = HASH_WIDTH, height = HASH_HEIGHT): string {
  if (gray.length !== width * height) {
    throw new Error(`dhashFromGray: expected ${width * height} samples, got ${gray.length}`);
  }

  let hex = '';
  let nibble = 0;
  let bitsInNibble = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = gray[y * width + x] ?? 0;
      const right = gray[y * width + x + 1] ?? 0;
      nibble = (nibble << 1) | (left > right ? 1 : 0);
      bitsInNibble++;
      if (bitsInNibble === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bitsInNibble = 0;
      }
    }
  }

  return hex;
}

/** Number of differing bits between two hex hashes; `Infinity` if they are not comparable. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;

  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const left = Number.parseInt(a[i]!, 16);
    const right = Number.parseInt(b[i]!, 16);
    if (Number.isNaN(left) || Number.isNaN(right)) return Infinity;
    let diff = left ^ right;
    while (diff) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}

/**
 * Whether an icon carries too little detail to identify anything.
 *
 * A blank square, a solid colour, or a faint one-pixel mark hashes to something
 * that sits within a few bits of every other flat icon. Without this gate the
 * table matches half the web to whichever flat brand icon it holds.
 */
export function isLowContrastIcon(gray: ArrayLike<number>, minRange = 32): boolean {
  if (gray.length === 0) return true;

  let min = 255;
  let max = 0;
  for (let i = 0; i < gray.length; i++) {
    const value = gray[i] ?? 0;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min < minRange;
}

/**
 * The brand whose icon this is, or null.
 *
 * Null when nothing is close enough *and* when more than one brand is: two
 * brands within six bits of the same icon means the icon does not identify
 * either of them, and guessing between them is how a false accusation gets
 * made. An ambiguous icon is not evidence.
 */
export function matchFaviconHash(
  hash: string,
  table: FaviconHashEntry[],
  maxDistance = DEFAULT_MAX_DISTANCE,
): FaviconMatch | null {
  let best: FaviconMatch | null = null;
  let qualifying = 0;

  for (const entry of table) {
    let closest = Infinity;
    for (const candidate of entry.hashes) {
      const distance = hammingDistance(hash, candidate);
      if (distance < closest) closest = distance;
    }
    if (closest > maxDistance) continue;

    qualifying++;
    if (!best || closest < best.distance) best = { domain: entry.domain, distance: closest };
  }

  return qualifying === 1 ? best : null;
}
