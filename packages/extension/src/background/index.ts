/**
 * MV3 service worker.
 *
 * Deliberately thin. It finds and reads the site's terms (it alone has the tabs API), hands the text to the offscreen document,
 * which owns the model and does the long work, and keeps what the popup needs in `chrome.storage.session`. It also scores
 * forms for the phishing warning, which needs no model at all.
 *
 * It can be stopped and restarted at any time, so nothing it needs later lives only in memory.
 */
import { registrableDomain, scoreForm, type RuleResult } from '@ppg/shared';
import type { Job } from '../analysis/analyzer.ts';
import type { AnalysisState } from '../analysis/state.ts';
import type { AssessResponse, ExtensionMessage } from '../messages.ts';
import { activeAccount, loadPrefs, onPrefsChanged, savePrefs } from '../prefs.ts';
import { acquire } from './acquire.ts';
import { startAnalysisInOffscreen } from './offscreen.ts';
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

async function assess(message: Extract<ExtensionMessage, { type: 'assess' }>): Promise<AssessResponse> {
  const prefs = await loadPrefs();
  if (prefs.paused) return { paused: true, worst: null };

  let worst: RuleResult | null = null;
  for (const observation of message.observations) {
    const result = scoreForm(observation, { allowlist: prefs.allowlist });
    if (result.verdict === 'safe') continue;
    if (!worst || result.score > worst.score) worst = result;
  }
  return {
    paused: false,
    worst: worst ? { score: worst.score, verdict: worst.verdict, reasons: worst.hits.map((hit) => hit.detail) } : null,
  };
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

const NOT_A_SITE: AnalysisState = { status: 'unavailable', domain: '', reason: 'This is not a regular website page.' };

/** What the popup should show for a tab right now. */
async function getState(tabId: number): Promise<AnalysisState> {
  const domain = await domainOfTab(tabId);
  if (!domain) return NOT_A_SITE;
  const prefs = await loadPrefs();
  if (!prefs.setupDone || !prefs.modelId) return { status: 'needs-setup' };

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
  if (!prefs.setupDone || !prefs.modelId) return { status: 'needs-setup' };

  const jobId = Date.now();
  const set = async (state: AnalysisState) => {
    await writeState(tabId, { jobId, state });
    await paintBadge(tabId, state);
    return state;
  };
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

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  switch (message?.type) {
    case 'assess':
      void assess(message).then(sendResponse);
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
