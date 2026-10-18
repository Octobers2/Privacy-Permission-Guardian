/**
 * End-to-end check: builds nothing, but loads the built extension into headless
 * Chromium, opens every labelled fixture under its real hostname, and asserts
 * that the banner says what the rule engine says it should.
 *
 *   bun run eval/run-banner-e2e.ts
 *
 * This is the automated form of the W1 acceptance criterion — "open a phishing
 * fixture, get a red banner; open a legitimate one, get nothing" — plus the
 * "no console errors" criterion for the extension's own pages.
 *
 * Covers the form warning (the part of the extension that needs no model). The analysis, setup, shared-mode and site flows have
 * their own end-to-end checks: run-analysis-e2e.ts, run-setup-e2e.ts, run-shared-e2e.ts and run-site-e2e.ts.
 *
 * Exits non-zero when a fixture is judged wrongly or any page logs an error.
 */
import { resolve } from 'node:path';
import { Browser } from './lib/chromium.ts';
import { CONTENT_SCRIPT_BUDGET_BYTES, contentScriptWeight } from './bundle-budget.ts';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { extractVisibleText, isVerbatim, pickMainContent } from '@ppg/shared/sanitize';
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

const failures: string[] = [];

console.log('=== per-page cost ===');
{
  const weight = contentScriptWeight(DIST);
  for (const file of weight.files) console.log(`  ${file.file.padEnd(40)} ${file.bytes.toLocaleString().padStart(9)}`);
  const withinBudget = weight.total <= CONTENT_SCRIPT_BUDGET_BYTES;
  console.log(
    `  ${withinBudget ? 'ok  ' : 'FAIL'} content script loads ${weight.total.toLocaleString()} bytes on every page` +
      ` (budget ${CONTENT_SCRIPT_BUDGET_BYTES.toLocaleString()})`,
  );
  if (!withinBudget) {
    failures.push(
      `content script is ${weight.total.toLocaleString()} bytes, over the ${CONTENT_SCRIPT_BUDGET_BYTES.toLocaleString()} budget` +
        ' — something heavy got imported into the page again',
    );
  }
}

const browser = await Browser.launch({
  extensionDir: DIST,
  hostResolverRules: hostResolverRules(),
  ignoreCertificateErrors: true,
});

console.log('\n=== extension pages ===');
for (const page of ['popup.html', 'options.html']) {
  const { value, problems } = await browser.visit<{ heading: string; upgraded: number; pending: number }>(
    `chrome-extension://${browser.extensionId}/${page}`,
    `(() => {
      const elements = [...document.querySelectorAll('*')].filter((el) => el.tagName.startsWith('MD-'));
      return {
        heading: document.querySelector('h1')?.textContent ?? '',
        upgraded: elements.filter((el) => el.shadowRoot).length,
        pending: elements.filter((el) => !el.shadowRoot).length,
      };
    })()`,
  );
  // The popup's contents depend on which tab is active, so rather than
  // demanding a particular component, require that every Material element the
  // page *did* render was upgraded. A CSP violation would leave them all inert.
  const ok = value?.heading && value.pending === 0 && problems.length === 0;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${page}  "${value?.heading}"  material elements: ${value?.upgraded ?? 0} upgraded, ${value?.pending ?? 0} inert`,
  );
  for (const problem of problems) console.log(`       console error: ${problem}`);
  if (!ok) {
    failures.push(`${page}: ${problems.join('; ') || `${value?.pending} material elements failed to upgrade`}`);
  }
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
    // Clicking the label rather than the switch: md-switch is a form-associated
    // custom element, so wrapping it in a <label> should associate. Svelte's
    // a11y check cannot see that and is suppressed at the source, which makes
    // this the test that keeps the suppression honest.
    `(async () => {
      [...document.querySelectorAll('label.row')].find((l) => l.textContent.includes('Pause warnings')).click();
      await new Promise((done) => setTimeout(done, 400));
      const stored = await chrome.storage.local.get('ppg-prefs');
      return { paused: stored['ppg-prefs']?.paused ?? null };
    })()`,
  );
  const pausedOk = toggled.value?.paused === true;
  console.log(`  ${pausedOk ? 'ok  ' : 'FAIL'} clicking the switch label writes paused=true`);
  if (!pausedOk) failures.push('options page: clicking the pause label did not toggle and persist');

  const phishing = loadFixtures().find((f) => f.label === 'phishing')!;
  const silenced = await browser.visit<Banner | null>(phishing.url, READ_BANNER);
  const silencedOk = silenced.value === null;
  console.log(`  ${silencedOk ? 'ok  ' : 'FAIL'} no banner on ${phishing.hostname} while paused`);
  if (!silencedOk) failures.push('paused mode still drew a banner');

  // Leave the profile in its default state so a rerun starts clean.
  await browser.visit(optionsUrl, `chrome.storage.local.remove('ppg-prefs')`, 300);
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
