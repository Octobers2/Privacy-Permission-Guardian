/**
 * MV3 service worker.
 *
 * Deliberately thin. It finds and reads the site's terms (it alone has the tabs API), hands the text to the offscreen document,
 * which owns the model and does the long work, and keeps what the popup needs in `chrome.storage.session`. It also scores
 * forms for the phishing warning, which needs no model at all.
 *
 * It can be stopped and restarted at any time, so nothing it needs later lives only in memory.
 */
import {
  classifyField,
  describePage,
  registrableDomain,
  scoreForm,
  scorePageSignals,
  scoreStandalonePage,
  type FormObservation,
  type RuleHit,
  type RuleResult,
} from '@ppg/shared';
import type { Job } from '../analysis/analyzer.ts';
import type { AnalysisState } from '../analysis/state.ts';
import type { AssessResponse, ExtensionMessage } from '../messages.ts';
import { activeAccount, isReady, loadPrefs, onPrefsChanged, savePrefs } from '../prefs.ts';
import { acquire } from './acquire.ts';
import { faviconMatchFor } from './favicon.ts';
import { startAnalysisInOffscreen } from './offscreen.ts';
import { lookupShared } from './shared-lookup.ts';
import { clearState, readState, saveResult, savedResultFor, writeState } from './storage.ts';

const COLOURS = { clean: '#1e8e3e', some: '#e37400', many: '#c5221f', busy: '#5f6368' } as const;

/* ------------------------------------------------------------------ badge */

async function paintBadge(tabId: number, state: AnalysisState | null): Promise<void> {
  const { paused } = await loadPrefs();
  if (!state || state.status === 'idle' || state.status === 'needs-setup' || state.status === 'unavailable' || state.status === 'error') {
    await chrome.action.setBadgeText({ tabId, text: paused ? '⏸' : '' });
    if (paused) await chrome.action.setBadgeBackgroundColor({ tabId, color: COLOURS.busy });
    return;
  }
  if (state.status === 'working') {
    await chrome.action.setBadgeText({ tabId, text: '…' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: COLOURS.busy });
    return;
  }
  const n = state.result.flagged.length;
  await chrome.action.setBadgeText({ tabId, text: String(n) });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: n === 0 ? COLOURS.clean : n < 8 ? COLOURS.some : COLOURS.many });
  await chrome.action.setTitle({ tabId, title: `${n} potentially unfair clause${n === 1 ? '' : 's'} found` });
}

async function paintPausedBadge(): Promise<void> {
  const { paused } = await loadPrefs();
  await chrome.action.setBadgeText({ text: paused ? '⏸' : '' });
  if (paused) await chrome.action.setBadgeBackgroundColor({ color: COLOURS.busy });
  await chrome.action.setTitle({ title: paused ? 'Privacy & Permission Guardian (paused)' : 'Privacy & Permission Guardian' });
}

/* -------------------------------------------------------------- form check */

/** Categories whose presence is what makes a third-party destination worth naming. */
const SENSITIVE_CATEGORIES = new Set(['password', 'credit_card', 'card_cvv', 'national_id', 'bank_account']);

function wantsSensitiveData(observations: FormObservation[]): boolean {
  return observations.some((observation) =>
    observation.form.fields.some((field) => SENSITIVE_CATEGORIES.has(classifyField(field))),
  );
}

/**
 * Whether this page has earned the one network request these checks can make.
 *
 * Hashing the favicon means fetching it, and a privacy tool that fetches
 * something on every page the user opens has a problem it cannot argue its way
 * out of. So the icon is only looked at once the page has already said
 * something: a form worth a few points, or a page-level finding of its own.
 * The result is cached per registrable domain, so a site the user visits daily
 * is fetched once a month.
 */
const FAVICON_GATE_SCORE = 15;

async function assess(
  message: Extract<ExtensionMessage, { type: 'assess' }>,
  sender: chrome.runtime.MessageSender,
): Promise<AssessResponse> {
  const prefs = await loadPrefs();
  if (prefs.paused) return { paused: true, worst: null };

  const { observations, signals } = message;
  const page = observations[0]?.page ?? null;
  const allowlist = prefs.allowlist;

  const scoreOptions = {
    allowlist,
    hasSensitiveFields: wantsSensitiveData(observations),
  };

  // The page context normally rides along on an observation. A page with no
  // form has none, so it comes from the sender instead — which is the browser's
  // own record of where the tab is, not something the page can claim.
  const context = page ?? (sender.tab?.url ? describePage(sender.tab.url, sender.tab.title ?? '') : null);
  let pageHits: RuleHit[] = context ? scorePageSignals(signals, context, scoreOptions) : [];

  let formResult = worstForm(observations, { allowlist, pageHits });

  if (prefs.faviconCheck && context && shouldCheckFavicon(formResult, pageHits)) {
    const faviconMatch = await faviconMatchFor(context.hostname, signals.iconUrls);
    if (faviconMatch) {
      pageHits = scorePageSignals(signals, context, { ...scoreOptions, faviconMatch });
      formResult = worstForm(observations, { allowlist, pageHits });
    }
  }

  const worst: RuleResult | null =
    formResult ?? (context ? nullIfSafe(scoreStandalonePage(pageHits, context, { allowlist })) : null);

  return {
    paused: false,
    worst: worst
      ? {
          score: worst.score,
          verdict: worst.verdict,
          reasons: worst.hits.map((hit) => hit.detail),
          kind: formResult ? 'form' : 'page',
        }
      : null,
  };
}

function nullIfSafe(result: RuleResult): RuleResult | null {
  return result.verdict === 'safe' ? null : result;
}

function worstForm(
  observations: FormObservation[],
  options: { allowlist: string[]; pageHits: RuleHit[] },
): RuleResult | null {
  let worst: RuleResult | null = null;
  for (const observation of observations) {
    const result = scoreForm(observation, options);
    if (result.verdict === 'safe') continue;
    if (!worst || result.score > worst.score) worst = result;
  }
  return worst;
}

function shouldCheckFavicon(formResult: RuleResult | null, pageHits: RuleHit[]): boolean {
  return (formResult?.score ?? 0) >= FAVICON_GATE_SCORE || pageHits.length > 0;
}

async function allowlistSite(hostname: string): Promise<void> {
  const { allowlist } = await loadPrefs();
  await savePrefs({ allowlist: [...new Set([...allowlist, registrableDomain(hostname)])] });
}

/* ---------------------------------------------------------------- analysis */

async function domainOfTab(tabId: number): Promise<string | null> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return null;
  try {
    const { hostname, protocol } = new URL(tab.url);
    return /^https?:$/.test(protocol) ? registrableDomain(hostname) : null;
  } catch {
    return null;
  }
}

/** Addresses the page offers as its terms: the page itself if it is one, then the links it carries. Never the page's text. */
async function policyHints(tabId: number): Promise<string[]> {
  try {
    const live = (await chrome.tabs.sendMessage(tabId, { type: 'extract-current-page' })) as { isPolicyPage?: boolean; policyUrl?: string } | undefined;
    const candidates = (await chrome.tabs.sendMessage(tabId, { type: 'policy-candidates' })) as { links?: string[] } | undefined;
    return [...(live?.isPolicyPage && live.policyUrl ? [live.policyUrl] : []), ...(candidates?.links ?? [])];
  } catch {
    return []; // a page that was open before the extension was installed has no content script; the domain alone still works
  }
}

const NOT_A_SITE: AnalysisState = { status: 'unavailable', domain: '', reason: 'This is not a regular website page.' };

/** What the popup should show for a tab right now. */
async function getState(tabId: number): Promise<AnalysisState> {
  const domain = await domainOfTab(tabId);
  if (!domain) return NOT_A_SITE;
  const prefs = await loadPrefs();
  if (!isReady(prefs)) return { status: 'needs-setup' };

  const stored = await readState(tabId);
  // A state belongs to the site it was computed for; after navigating elsewhere it is stale.
  if (stored && 'domain' in stored.state && stored.state.domain === domain && stored.state.status !== 'idle') return stored.state;

  const saved = await savedResultFor(domain);
  if (saved) return { status: 'ready', domain, result: saved };
  return { status: 'idle', domain };
}

async function analyseTab(tabId: number): Promise<AnalysisState> {
  const domain = await domainOfTab(tabId);
  if (!domain) return NOT_A_SITE;
  const prefs = await loadPrefs();
  if (!isReady(prefs)) return { status: 'needs-setup' };

  const jobId = Date.now();
  const set = async (state: AnalysisState) => {
    await writeState(tabId, { jobId, state });
    await paintBadge(tabId, state);
    return state;
  };

  // Shared-only mode: no text is read and no model runs; ask the public cache about this site.
  if (prefs.mode === 'shared') {
    await set({ status: 'working', domain, stage: 'checking-cache', done: 0, total: 0, flagged: [] });
    return set(await lookupShared({ serverUrl: prefs.serverUrl, domain, hints: await policyHints(tabId) }));
  }

  if (prefs.modelId === null) return { status: 'needs-setup' }; // not in shared mode, so a model must be installed (isReady allows both)
  await set({ status: 'working', domain, stage: 'reading', done: 0, total: 0, flagged: [] });

  const got = await acquire(tabId);
  if (!got.ok) return set({ status: 'unavailable', domain, reason: got.reason, links: got.links });

  const job: Job = {
    id: jobId,
    tabId,
    policyUrl: got.document.policyUrl,
    domain,
    text: got.document.text,
    truncated: got.document.truncated,
    prefs: {
      serverUrl: prefs.serverUrl,
      modelId: prefs.modelId,
      summary: prefs.summary,
      byok: prefs.byok,
      token: activeAccount(prefs)?.token ?? null,
    },
  };
  try {
    await startAnalysisInOffscreen(job);
  } catch (error) {
    return set({ status: 'error', domain, message: error instanceof Error ? error.message : String(error) });
  }
  return { status: 'working', domain, stage: 'privacy-check', done: 0, total: 0, flagged: [] };
}

/** Progress reports from the offscreen document: kept only if they belong to the tab's newest job. */
async function onAnalysisState(tabId: number, jobId: number, state: AnalysisState): Promise<void> {
  const current = await readState(tabId);
  if (current && current.jobId !== jobId) return; // a newer analysis has started since
  await writeState(tabId, { jobId, state });
  await paintBadge(tabId, state);
}

/* ---------------------------------------------------------------- plumbing */

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  switch (message?.type) {
    case 'assess':
      void assess(message, sender).then(sendResponse);
      return true;
    case 'allowlist-site':
      void allowlistSite(message.hostname).then(() => sendResponse({ ok: true }));
      return true;
    case 'get-state':
      void getState(message.tabId).then(sendResponse);
      return true;
    case 'analyse':
      void analyseTab(message.tabId).then(sendResponse);
      return true;
    case 'analysis-state':
      void onAnalysisState(message.tabId, message.jobId, message.state);
      return false;
    case 'save-result':
      void saveResult(message.result);
      return false;
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => void clearState(tabId));
// Navigating away from the site an analysis was for makes its badge wrong.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) void getState(tabId).then((state) => paintBadge(tabId, state.status === 'ready' ? state : null));
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  void paintPausedBadge();
  // First install: the model has to be downloaded before anything works, so open the setup page straight away.
  if (reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
});
chrome.runtime.onStartup.addListener(() => void paintPausedBadge());
onPrefsChanged(() => void paintPausedBadge());
