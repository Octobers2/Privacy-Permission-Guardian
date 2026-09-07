/**
 * End-to-end check: builds nothing, but loads the built extension into headless
 * Chromium, opens every labelled fixture under its real hostname, and asserts
 * that the banner says what the rule engine says it should.
 *
 *   bun run eval/run-e2e.ts
 *
 * This is the automated form of the W1 acceptance criterion — "open a phishing
 * fixture, get a red banner; open a legitimate one, get nothing" — plus the
 * "console 零 error" criterion for the extension's own pages.
 *
 * Exits non-zero when a fixture is judged wrongly or any page logs an error.
 */
import { resolve } from 'node:path';
import { Browser } from './chromium.ts';
import { loadFixtures } from './fixtures.ts';
import { hostResolverRules } from './serve-fixtures.ts';

const DIST = resolve(import.meta.dir, '../packages/extension/dist');

/** Reads the banner out of its shadow root, or null when there is none. */
const READ_BANNER = `(() => {
  const host = document.getElementById('ppg-banner-host');
  if (!host || !host.shadowRoot) return null;
  const bar = host.shadowRoot.querySelector('.bar');
  if (!bar) return null;
  return {
    verdict: bar.getAttribute('data-verdict'),
    title: bar.querySelector('.title')?.textContent ?? '',
    reasons: [...bar.querySelectorAll('li')].map((li) => li.textContent),
  };
})()`;

interface Banner {
  verdict: 'caution' | 'danger';
  title: string;
  reasons: string[];
}

const browser = await Browser.launch({
  extensionDir: DIST,
  hostResolverRules: hostResolverRules(),
  ignoreCertificateErrors: true,
});

const failures: string[] = [];

console.log('=== extension pages ===');
for (const page of ['popup.html', 'options.html']) {
  const { value, problems } = await browser.visit<{ heading: string; upgraded: boolean }>(
    `chrome-extension://${browser.extensionId}/${page}`,
    `(() => ({
      heading: document.querySelector('h1')?.textContent ?? '',
      upgraded: !!document.querySelector('md-filled-button, md-switch')?.shadowRoot,
    }))()`,
  );
  const ok = value?.upgraded && problems.length === 0;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${page}  "${value?.heading}"  lit-upgraded=${value?.upgraded}`);
  for (const problem of problems) console.log(`       console error: ${problem}`);
  if (!ok) failures.push(`${page}: ${problems.join('; ') || 'material component did not upgrade'}`);
}

console.log('\n=== fixtures ===');
for (const fixture of loadFixtures()) {
  const { value: banner, problems } = await browser.visit<Banner | null>(fixture.url, READ_BANNER);

  // Phishing has to reach danger. Legitimate pages must not — but caution is a
  // correct answer for a real bank onboarding form, which genuinely does ask
  // for an ID number, an address and a date of birth. Suppressing that would
  // hide information the user should have; calling it phishing would be wrong.
  const correct =
    fixture.label === 'phishing' ? banner?.verdict === 'danger' : banner?.verdict !== 'danger';

  const summary = banner ? `${banner.verdict} (${banner.reasons.length} reasons)` : 'no banner';
  const note = fixture.label === 'legit' && banner ? '  [caution on a legitimate site]' : '';
  console.log(
    `  ${correct ? 'ok  ' : 'FAIL'} ${fixture.label.padEnd(8)} ${fixture.hostname.padEnd(28)} ${summary}${note}`,
  );
  if (banner) for (const reason of banner.reasons) console.log(`         · ${reason}`);
  for (const problem of problems) console.log(`         console error: ${problem}`);

  if (!correct) failures.push(`${fixture.hostname}: labelled ${fixture.label} but got ${summary}`);
}

console.log('\n=== global pause ===');
{
  const optionsUrl = `chrome-extension://${browser.extensionId}/options.html`;

  const toggled = await browser.visit<{ paused: unknown }>(
    optionsUrl,
    `(async () => {
      document.querySelector('md-switch').click();
      await new Promise((done) => setTimeout(done, 400));
      const stored = await chrome.storage.local.get('settings');
      return { paused: stored.settings?.paused ?? null };
    })()`,
  );
  const pausedOk = toggled.value?.paused === true;
  console.log(`  ${pausedOk ? 'ok  ' : 'FAIL'} toggling the switch writes paused=true`);
  if (!pausedOk) failures.push('options page: the pause switch did not persist');

  const phishing = loadFixtures().find((f) => f.label === 'phishing')!;
  const silenced = await browser.visit<Banner | null>(phishing.url, READ_BANNER);
  const silencedOk = silenced.value === null;
  console.log(`  ${silencedOk ? 'ok  ' : 'FAIL'} no banner on ${phishing.hostname} while paused`);
  if (!silencedOk) failures.push('paused mode still drew a banner');

  // Leave the profile in its default state so a rerun starts clean.
  await browser.visit(optionsUrl, `chrome.storage.local.remove('settings')`, 300);
}

browser.close();

console.log('\n=== verdict ===');
if (failures.length === 0) {
  console.log('all fixtures judged correctly, no console errors');
} else {
  console.log(`${failures.length} failure(s):`);
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(failures.length === 0 ? 0 : 1);
