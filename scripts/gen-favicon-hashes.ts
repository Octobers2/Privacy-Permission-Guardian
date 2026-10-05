/**
 * Builds the favicon reference table.
 *
 *   bun run favicons                  # every brand in brands.json
 *   bun run favicons --only apple.com,paypal.com
 *   bun run favicons --dry-run        # print, do not write
 *
 * Needs the network and a `chromium` on PATH. Run it by hand; the output is
 * committed, because a detection that depends on being able to reach 177 brand
 * sites is a detection that stops working on the day it is needed.
 *
 * The hashing is done by `scripts/favicon-probe.ts`, which bundles the
 * extension's own `dhashFromGray`. That is the entire point of the
 * arrangement: a generator with its own copy of the arithmetic would drift
 * from the runtime and nothing would fail — the extension would simply stop
 * recognising icons, quietly.
 *
 * Brands whose icon carries no detail are skipped rather than stored. A flat
 * square sits within a few bits of every other flat square, and one in the
 * table would match half the web.
 */
import { resolve } from 'node:path';
import { BRANDS } from '@ppg/shared/lookalike';
import type { FaviconHashEntry } from '@ppg/shared/favicon';
import { Browser } from '../packages/server/src/chromium.ts';

const only = flagValue('--only')?.split(',').map((d) => d.trim()).filter(Boolean);
const dryRun = process.argv.includes('--dry-run');
const OUTPUT = resolve(import.meta.dir, '../packages/shared/src/favicon-hashes.json');

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** The probe, bundled once, injected into every tab. */
async function probeSource(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, 'favicon-probe.ts')],
    target: 'browser',
    format: 'iife',
    minify: true,
  });
  if (!built.success) throw new Error(`could not bundle the favicon probe: ${built.logs.join(', ')}`);
  return built.outputs[0]!.text();
}

async function hashesFor(browser: Browser, probe: string, domain: string): Promise<string[]> {
  const tab = await browser.openTab(`https://${domain}/`, 2_000);
  try {
    await tab.evaluate(probe);
    const urls = await tab.evaluate<string[]>('__ppgIconUrls()');

    const hashes: string[] = [];
    // Two is enough: a site's declared icon and its /favicon.ico. Beyond that
    // the extras are platform tiles that nobody sees in a tab strip.
    for (const url of urls.slice(0, 2)) {
      const hash = await tab.evaluate<string | null>(`__ppgHashIcon(${JSON.stringify(url)})`);
      if (hash && !hashes.includes(hash)) hashes.push(hash);
    }
    return hashes;
  } finally {
    await tab.close();
  }
}

const wanted = BRANDS.filter((brand) => !only || only.includes(brand.domain));
console.log(`hashing ${wanted.length} brand icons\n`);

const browser = await Browser.launch();
const probe = await probeSource();
const table: FaviconHashEntry[] = [];
let skipped = 0;

try {
  for (const brand of wanted) {
    try {
      const hashes = await hashesFor(browser, probe, brand.domain);
      if (hashes.length === 0) {
        skipped++;
        console.log(`  --   ${brand.domain.padEnd(28)} no icon with enough detail`);
        continue;
      }
      table.push({ domain: brand.domain, hashes });
      console.log(`  ok   ${brand.domain.padEnd(28)} ${hashes.join(' ')}`);
    } catch (error) {
      skipped++;
      console.log(`  --   ${brand.domain.padEnd(28)} ${error instanceof Error ? error.message : error}`);
    }
  }
} finally {
  browser.close();
}

/* --------------------------------------------------------------- collisions */

// Two brands within the matching distance of each other make both unusable:
// `matchFaviconHash` refuses an ambiguous icon, by design. Better to see the
// pair named here than to wonder later why neither ever matches.
const { hammingDistance, DEFAULT_MAX_DISTANCE } = await import('@ppg/shared/favicon');
const collisions: string[] = [];
for (let i = 0; i < table.length; i++) {
  for (let j = i + 1; j < table.length; j++) {
    const close = table[i]!.hashes.some((a) =>
      table[j]!.hashes.some((b) => hammingDistance(a, b) <= DEFAULT_MAX_DISTANCE),
    );
    if (close) collisions.push(`${table[i]!.domain} ~ ${table[j]!.domain}`);
  }
}

console.log(`\n${table.length} hashed, ${skipped} skipped`);
if (collisions.length) {
  console.log(`\n${collisions.length} pairs are too close to tell apart; neither will ever match:`);
  for (const pair of collisions) console.log(`  ${pair}`);
}

if (dryRun) {
  console.log('\n--dry-run: nothing written');
} else {
  await Bun.write(OUTPUT, `${JSON.stringify(table, null, 2)}\n`);
  console.log(`\nwrote ${OUTPUT}`);
}
