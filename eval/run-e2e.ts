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
import { CONTENT_SCRIPT_BUDGET_BYTES, contentScriptWeight } from './bundle-budget.ts';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { extractVisibleText, isVerbatim, pickMainContent } from '@ppg/shared/sanitize';
import { loadFixtures } from './fixtures.ts';
import { hostResolverRules, MOCK_LLM_HOST } from './serve-fixtures.ts';

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

console.log('\n=== policy summary, end to end ===');
{
  const optionsUrl = `chrome-extension://${browser.extensionId}/options.html`;
  const site = 'https://www.datahungry.example/';

  // Point the extension at the mock endpoint the fixture server exposes, so the
  // whole pipeline runs without an API key: scout the policy link, fetch it,
  // sanitise, prompt, validate, verify quotes, score, cache.
  await browser.visit(
    optionsUrl,
    `chrome.storage.local.set({ settings: {
      mode: 'direct',
      baseUrl: 'https://${MOCK_LLM_HOST}/v1',
      apiKey: 'test-key',
      model: 'mock',
    } })`,
    300,
  );

  // Rebuild the text the extension would have extracted, using the same
  // production code, so the check compares like with like. Comparing against
  // the raw HTML fails for any quote that spans a tag boundary.
  const policyDoc = parseHTML(
    readFileSync(resolve(import.meta.dir, 'fixtures/sites/www.datahungry.example/privacy.html'), 'utf8'),
  ).document as unknown as Document;
  const policySource = extractVisibleText(pickMainContent(policyDoc)).text;

  const siteTab = await browser.openTab(site);
  const options = await browser.openTab(optionsUrl);

  const summary = await options.evaluate<any>(`(async () => {
    const [tab] = await chrome.tabs.query({ url: '${site}*' });
    return chrome.runtime.sendMessage({ type: 'analyse-policy', tabId: tab.id });
  })()`);

  const checks: [string, boolean][] = [
    ['the policy was found and summarised', summary?.status === 'ready'],
    ['two verifiable points survived', summary?.summary?.points?.length === 2],
    ['the invented quote was dropped', summary?.summary?.droppedPoints === 1],
    ['the score came from the surviving severities', summary?.summary?.riskScore === 37],
    [
      'every surviving quote appears verbatim in the policy file',
      // Checked against the fixture on disk rather than against sentences this
      // test picked in advance: the point is that the extension verified them,
      // not that the mock happened to choose the ones we guessed.
      (summary?.summary?.points ?? []).length > 0 &&
        (summary?.summary?.points ?? []).every((point: any) => isVerbatim(point.quote, policySource)),
    ],
  ];

  for (const [label, passed] of checks) {
    console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${label}`);
    if (!passed) failures.push(`policy pipeline: ${label}`);
  }
  for (const point of summary?.summary?.points ?? []) {
    console.log(`         · ${point.title} — 「${point.quote.slice(0, 60)}…」`);
  }
  if (summary?.status !== 'ready') console.log(`       got: ${JSON.stringify(summary)}`);

  // A second run must come from the cache rather than the endpoint.
  const again = await options.evaluate<any>(`(async () => {
    const [tab] = await chrome.tabs.query({ url: '${site}*' });
    return chrome.runtime.sendMessage({ type: 'analyse-policy', tabId: tab.id });
  })()`);
  const cached = again?.cached === true;
  console.log(`  ${cached ? 'ok  ' : 'FAIL'} the second request is served from the cache`);
  if (!cached) failures.push('policy pipeline: the summary was not cached');

  await options.evaluate(`chrome.storage.local.clear()`);
  await options.close();
  await siteTab.close();
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
      document.querySelector('label.row').click();
      await new Promise((done) => setTimeout(done, 400));
      const stored = await chrome.storage.local.get('settings');
      return { paused: stored.settings?.paused ?? null };
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
