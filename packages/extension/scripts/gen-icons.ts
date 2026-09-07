/**
 * Rasterises the toolbar icon at the four sizes Chrome asks for.
 *
 *   bun run scripts/gen-icons.ts
 *
 * Generated at development time and committed, like the colour tokens: the
 * build should not depend on a browser being installed, and there is no reason
 * to add an image library for one shield.
 *
 * The glyph is a shield with a keyhole, in the same seed colour the Material
 * palette is generated from, so the toolbar matches the popup.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Browser } from '../../../eval/chromium.ts';

const SIZES = [16, 32, 48, 128];
const OUT = resolve(import.meta.dir, '../src/assets/icons');

/** Kept in step with the seed passed to gen-theme.ts. */
const PRIMARY = '#2E6FF2';

function svg(size: number): string {
  // The shield is drawn on a 128 grid and scaled, so every size is the same
  // shape rather than four separately-tuned drawings.
  const radius = size <= 32 ? size * 0.22 : size * 0.2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="${(radius / size) * 128}" fill="${PRIMARY}"/>
  <path d="M64 22 26 38v28c0 24.4 16.1 47.2 38 53 21.9-5.8 38-28.6 38-53V38L64 22Z" fill="#fff"/>
  <path d="M64 34 38 45v21c0 18.7 11.6 36.2 26 41.2 14.4-5 26-22.5 26-41.2V45L64 34Z" fill="${PRIMARY}"/>
  <circle cx="64" cy="62" r="11" fill="#fff"/>
  <path d="M59 62h10l-2 22h-6l-2-22Z" fill="#fff"/>
</svg>`;
}

mkdirSync(OUT, { recursive: true });
const browser = await Browser.launch();

for (const size of SIZES) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

  await browser.send('Emulation.setDeviceMetricsOverride',
    { width: size, height: size, deviceScaleFactor: 1, mobile: false }, sessionId);
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Page.navigate', {
    url: `data:text/html,${encodeURIComponent(
      `<style>html,body{margin:0;background:transparent}</style>${svg(size)}`,
    )}`,
  }, sessionId);
  await Bun.sleep(400);

  const { data } = await browser.send('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false, omitBackground: true }, sessionId);
  await Bun.write(resolve(OUT, `icon-${size}.png`), Buffer.from(data, 'base64'));
  await browser.send('Target.closeTarget', { targetId });
  console.log(`wrote icon-${size}.png`);
}

browser.close();
process.exit(0);
