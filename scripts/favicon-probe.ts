/**
 * The hasher, bundled and injected into a page by `gen-favicon-hashes.ts`.
 *
 * It exists as its own entry point for the same reason `render-probe.ts` does:
 * so the table is built by *the same* `dhashFromGray` the service worker runs.
 * A generator with its own copy of the arithmetic would produce a table that
 * silently stops matching the day either side is touched, and every comparison
 * the extension makes would be meaningless without anything failing.
 *
 * It runs inside a page because that is where the image decoder is. Bun has
 * none, and the browser this project already drives over CDP has one for every
 * format a favicon is ever served in, SVG included.
 */
import { dhashFromGray, isLowContrastIcon, HASH_HEIGHT, HASH_WIDTH } from '@ppg/shared/favicon';

export interface IconProbeResult {
  /** The hash, or null when the icon did not decode or carries no detail. */
  hash: string | null;
  /** Absolute URLs of the icons the page declares, plus the default path. */
  iconUrls: string[];
}

declare global {
  // eslint-disable-next-line no-var
  var __ppgHashIcon: ((url: string) => Promise<string | null>) | undefined;
  // eslint-disable-next-line no-var
  var __ppgIconUrls: (() => string[]) | undefined;
}

globalThis.__ppgIconUrls = () => {
  const urls: string[] = [];
  for (const link of document.querySelectorAll('link[rel]')) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    if (!/\b(?:icon|shortcut|apple-touch-icon|mask-icon)\b/.test(rel)) continue;
    const href = link.getAttribute('href');
    if (href) urls.push(new URL(href, location.href).href);
  }
  urls.push(new URL('/favicon.ico', location.href).href);
  return [...new Set(urls)];
};

globalThis.__ppgHashIcon = async (url: string) => {
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) return null;

    const blob = await response.blob();
    if (blob.size === 0) return null;

    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = HASH_WIDTH;
    canvas.height = HASH_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, HASH_WIDTH, HASH_HEIGHT);
    bitmap.close();

    // Identical compositing to `background/favicon.ts`: an icon is mostly
    // transparent around the mark, and white is what a browser shows behind it.
    const pixels = context.getImageData(0, 0, HASH_WIDTH, HASH_HEIGHT).data;
    const gray = new Uint8Array(pixels.length / 4);
    for (let i = 0; i < gray.length; i++) {
      const alpha = (pixels[i * 4 + 3] ?? 0) / 255;
      const value =
        0.299 * (pixels[i * 4] ?? 0) + 0.587 * (pixels[i * 4 + 1] ?? 0) + 0.114 * (pixels[i * 4 + 2] ?? 0);
      gray[i] = Math.round(value * alpha + 255 * (1 - alpha));
    }

    if (isLowContrastIcon(gray)) return null;
    return dhashFromGray(gray, HASH_WIDTH, HASH_HEIGHT);
  } catch {
    return null;
  }
};
