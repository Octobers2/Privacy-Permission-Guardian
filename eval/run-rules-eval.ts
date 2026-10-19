/**
 * Measures the form detector against the labelled fixture set.
 *
 *   bun run eval/run-rules-eval.ts                 # rules only
 *   bun run eval/run-rules-eval.ts --with-llm      # all three arms
 *   bun run eval/run-rules-eval.ts --markdown      # table for docs/evaluation.md
 *
 * The LLM arms need an endpoint:
 *
 *   PPG_BASE_URL=https://api.openai.com/v1 PPG_API_KEY=… PPG_MODEL=gpt-4o-mini \
 *     bun run eval/run-rules-eval.ts --with-llm
 *
 * Without one it runs the rules arm and says so, rather than printing numbers
 * nothing produced.
 *
 * Everything here calls the same `extractForms`, `collectPageSignals`,
 * `scorePageSignals` and `scoreForm` the extension runs in the browser. A
 * separate "close enough" implementation for the harness would make every
 * number in the report meaningless.
 *
 * Two things the browser does are missing here, and neither can be faked:
 *
 * - **The favicon hash.** Deciding that an icon is Apple's needs an image
 *   decoder, and linkedom has none. `favicon_brand_mismatch` is therefore not
 *   represented in these numbers at all; its arithmetic is unit-tested in
 *   `packages/shared/test/favicon.test.ts` and its end-to-end behaviour in
 *   `eval/run-e2e.ts`. `favicon_hotlinked`, which is pure DOM, is measured.
 * - **Observed requests.** `PerformanceObserver` needs a running page, so
 *   `sendingHosts` is empty and `sensitive_post_third_party` is measured only
 *   on the hosts a page names statically.
 */
import { parseHTML } from 'linkedom';
import {
  buildFormPrompt,
  chatJson,
  classifyField,
  collectPageSignals,
  extractForms,
  FormAssessmentSchema,
  describePage,
  scoreForm,
  scorePageSignals,
  scoreStandalonePage,
  stripQuery,
  type EndpointConfig,
  type FormAssessment,
  type FormObservation,
  type RuleResult,
} from '@ppg/shared';
import { fixtureHtml, loadFixtures, type Fixture } from './fixtures.ts';
import { confusionOf, formatMetrics, markdownTable, metricsOf, type Metrics } from './metrics.ts';

const withLlm = process.argv.includes('--with-llm');
const asMarkdown = process.argv.includes('--markdown');

const endpoint: EndpointConfig = {
  baseUrl: Bun.env.PPG_BASE_URL ?? '',
  apiKey: Bun.env.PPG_API_KEY ?? '',
  model: Bun.env.PPG_MODEL ?? 'gpt-4o-mini',
  temperature: 0,
  maxTokens: 800,
  timeoutMs: 40_000,
};

interface Scored {
  fixture: Fixture;
  observation: FormObservation | null;
  rules: RuleResult | null;
}

/** Categories whose presence makes a third-party destination worth naming; mirrors the worker. */
const SENSITIVE_CATEGORIES = new Set(['password', 'credit_card', 'card_cvv', 'national_id', 'bank_account']);

/** Runs the production extraction and scoring over a fixture's HTML. */
function scoreFixture(fixture: Fixture): Scored {
  const doc = parseHTML(fixtureHtml(fixture)).document as unknown as Document;
  const observations = extractForms(doc, fixture.url);

  // The same order the service worker uses: page signals first, folded into
  // every form's score, and standing on their own when there is no form.
  const page = observations[0]?.page ?? describePage(fixture.url, doc.title ?? '');
  const signals = collectPageSignals(doc, fixture.url);
  const pageHits = scorePageSignals(signals, page, {
    hasSensitiveFields: observations.some((observation) =>
      observation.form.fields.some((field) => SENSITIVE_CATEGORIES.has(classifyField(field))),
    ),
  });

  let worstObservation: FormObservation | null = null;
  let worst: RuleResult | null = null;
  for (const observation of observations) {
    const result = scoreForm(observation, { pageHits });
    if (!worst || result.score > worst.score) {
      worst = result;
      worstObservation = observation;
    }
  }

  if (!worst) {
    const standalone = scoreStandalonePage(pageHits, page);
    if (standalone.verdict !== 'safe') worst = standalone;
  }

  return { fixture, observation: worstObservation, rules: worst };
}

async function askModel(scored: Scored, ruleScore: number, ruleHits: string[]): Promise<FormAssessment | null> {
  if (!scored.observation) return null;
  const { page, form } = scored.observation;
  try {
    const { value } = await chatJson(
      endpoint,
      buildFormPrompt({
        page: { ...page, url: stripQuery(page.url) },
        fields: form.fields,
        actionOrigin: form.actionOrigin,
        ruleScore,
        ruleHits,
        textSnippet: '',
      }),
      FormAssessmentSchema,
    );
    return value;
  } catch (error) {
    console.error(`  model failed on ${scored.fixture.hostname}: ${error}`);
    return null;
  }
}

const onlyCollected = process.argv.includes('--collected-only');

const fixtures = loadFixtures().filter((f) => !onlyCollected || f.source === 'collected');
const scored = fixtures.map(scoreFixture);
const collectedCount = fixtures.filter((f) => f.source === 'collected').length;

const arms: { arm: string; metrics: Metrics }[] = [];

/* ------------------------------------------------------------ rules only */

const rulesResults = scored.map((entry) => ({
  actualPhishing: entry.fixture.label === 'phishing',
  predictedPhishing: entry.rules?.verdict === 'danger',
}));
arms.push({ arm: 'Rules only', metrics: metricsOf(confusionOf(rulesResults)) });

/* ------------------------------------------------- llm only, rules + llm */

if (withLlm) {
  if (!endpoint.baseUrl) {
    console.error('--with-llm needs PPG_BASE_URL (and usually PPG_API_KEY). Skipping the model arms.\n');
  } else {
    const llmOnly: { actualPhishing: boolean; predictedPhishing: boolean }[] = [];
    const combined: { actualPhishing: boolean; predictedPhishing: boolean }[] = [];

    for (const entry of scored) {
      const actualPhishing = entry.fixture.label === 'phishing';
      const ruleScore = entry.rules?.score ?? 0;
      const ruleHits = entry.rules?.hits.map((hit) => hit.id) ?? [];

      // Blind arm: the model gets no rule findings at all, so the comparison
      // measures what it adds rather than how well it agrees with us.
      const blind = await askModel(entry, 0, []);
      llmOnly.push({ actualPhishing, predictedPhishing: blind?.verdict === 'danger' });

      // Production arm: rules escalate, and only then does the model speak.
      let predicted = entry.rules?.verdict === 'danger';
      if (ruleScore >= 30) {
        const informed = await askModel(entry, ruleScore, ruleHits);
        if (informed) predicted = informed.verdict === 'danger';
      }
      combined.push({ actualPhishing, predictedPhishing: predicted });
    }

    arms.push({ arm: 'LLM only', metrics: metricsOf(confusionOf(llmOnly)) });
    arms.push({ arm: 'Rules + LLM', metrics: metricsOf(confusionOf(combined)) });
  }
}

/* ----------------------------------------------------------------- output */

if (asMarkdown) {
  console.log(markdownTable(arms));
} else {
  console.log(
    `fixtures: ${fixtures.length} ` +
      `(${fixtures.filter((f) => f.label === 'phishing').length} phishing, ` +
      `${collectedCount} collected, ${fixtures.length - collectedCount} synthetic)\n`,
  );

  console.log('per fixture (rules only)');
  for (const entry of scored) {
    const verdict = entry.rules?.verdict ?? 'safe';
    const correct = (entry.fixture.label === 'phishing') === (verdict === 'danger');
    console.log(
      `  ${correct ? ' ' : '!'} ${entry.fixture.label.padEnd(8)} ${entry.fixture.hostname.padEnd(28)}` +
        ` ${String(entry.rules?.score ?? 0).padStart(3)}  ${verdict}`,
    );
  }

  console.log();
  for (const { arm, metrics } of arms) console.log(formatMetrics(arm, metrics), '\n');

  if (collectedCount === 0) {
    console.log(
      'WARNING: every fixture is synthetic — written by this project while looking at the rules.\n' +
        '  These numbers measure whether the code does what it was written to do, not whether it\n' +
        '  detects phishing. Do not put them in the report as a detection rate. Add collected\n' +
        '  snapshots (see eval/fixtures/README.md) and rerun with --collected-only.\n',
    );
  } else if (collectedCount < 20) {
    console.log(`NOTE: only ${collectedCount} collected fixtures; the interval around these numbers is wide.\n`);
  }

  if (!withLlm) {
    console.log('Rules arm only. Pass --with-llm with PPG_BASE_URL set to measure the model arms.');
  }
  console.log('Pass --markdown for a table to paste into docs/evaluation.md.');
}
