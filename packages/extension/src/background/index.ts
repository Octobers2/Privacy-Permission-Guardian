/**
 * MV3 service worker.
 *
 * Holds everything expensive: the rule engine, the public suffix list, the
 * settings schema, the summary cache and the model calls. Loaded once per
 * browser session rather than once per page.
 */
import {
  humanMessageFor,
  registrableDomain,
  riskBand,
  scoreForm,
  sha256Hex,
  type ConnectionCheck,
  type RuleResult,
  type Settings,
} from '@ppg/shared';
import type {
  AssessResponse,
  ExtensionMessage,
  ScoutPolicyResponse,
  SummaryState,
} from '../messages.ts';
import { loadSettings, onSettingsChanged, saveSettings } from '../settings.ts';
import { readSummary, writeSummary } from './cache.ts';
import { checkConnection, summarisePolicy } from './llm-router.ts';

const BAND_COLOURS = { low: '#1e8e3e', moderate: '#e37400', high: '#c5221f' } as const;

/* ------------------------------------------------------------------ badge */

async function paintPausedBadge(): Promise<void> {
  const { paused } = await loadSettings();
  if (paused) {
    await chrome.action.setBadgeText({ text: '⏸' });
    await chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
    await chrome.action.setTitle({ title: 'Privacy & Permission Guardian — 已暫停' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Privacy & Permission Guardian' });
  }
}

async function paintScoreBadge(tabId: number, score: number): Promise<void> {
  const band = riskBand(score);
  await chrome.action.setBadgeText({ tabId, text: String(score) });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: BAND_COLOURS[band] });
}

/* -------------------------------------------------------------- form check */

async function assess(message: Extract<ExtensionMessage, { type: 'assess' }>): Promise<AssessResponse> {
  const settings = await loadSettings();
  if (settings.paused) return { paused: true, worst: null };

  let worst: RuleResult | null = null;
  for (const observation of message.observations) {
    const result = scoreForm(observation, { allowlist: settings.allowlist });
    if (result.verdict === 'safe') continue;
    if (!worst || result.score > worst.score) worst = result;
  }

  return {
    paused: false,
    worst: worst
      ? { score: worst.score, verdict: worst.verdict, reasons: worst.hits.map((hit) => hit.detail) }
      : null,
  };
}

async function allowlistSite(hostname: string): Promise<void> {
  const { allowlist } = await loadSettings();
  await saveSettings({ allowlist: [...new Set([...allowlist, registrableDomain(hostname)])] });
}

/* ---------------------------------------------------------- policy summary */

async function domainOfTab(tabId: number): Promise<string | null> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return null;
  try {
    const { hostname, protocol } = new URL(tab.url);
    if (!/^https?:$/.test(protocol)) return null;
    return registrableDomain(hostname);
  } catch {
    return null;
  }
}

async function getSummary(tabId: number): Promise<SummaryState> {
  const domain = await domainOfTab(tabId);
  if (!domain) return { status: 'unavailable', domain: '', reason: '呢一頁唔係普通網站（唔係 http/https）。' };

  const cached = await readSummary(domain);
  if (cached) {
    void paintScoreBadge(tabId, cached.riskScore);
    return { status: 'ready', domain, cached: true, summary: cached };
  }
  return { status: 'idle', domain };
}

/**
 * Reads and summarises the site's policy.
 *
 * Nothing here runs on its own: the user has to press the button in the popup.
 * Summarising automatically on every new domain would spend tokens the user
 * never agreed to spend, and would send a page's text to an endpoint before
 * they asked for that.
 */
async function analysePolicy(tabId: number): Promise<SummaryState> {
  const domain = await domainOfTab(tabId);
  if (!domain) return { status: 'unavailable', domain: '', reason: '呢一頁唔係普通網站。' };

  const settings: Settings = await loadSettings();

  let document: ScoutPolicyResponse | null;
  try {
    document = await chrome.tabs.sendMessage(tabId, { type: 'scout-policy' });
  } catch {
    return {
      status: 'unavailable',
      domain,
      reason: '讀唔到呢一頁。試下重新載入個頁面再嚟。',
    };
  }

  if (!document) {
    return {
      status: 'unavailable',
      domain,
      reason: '喺呢個網站搵唔到私隱政策或者服務條款。',
    };
  }

  const contentHash = await sha256Hex(document.text);
  const cached = await readSummary(domain, contentHash);
  if (cached) {
    void paintScoreBadge(tabId, cached.riskScore);
    return { status: 'ready', domain, cached: true, summary: cached };
  }

  try {
    const summary = await summarisePolicy(
      settings,
      { domain, policyUrl: document.policyUrl, text: document.text, truncated: document.truncated },
      contentHash,
    );
    await writeSummary(domain, contentHash, summary);
    void paintScoreBadge(tabId, summary.riskScore);
    return { status: 'ready', domain, cached: false, summary };
  } catch (error) {
    return { status: 'error', domain, message: humanMessageFor(error) };
  }
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
    case 'get-summary':
      void getSummary(message.tabId).then(sendResponse);
      return true;
    case 'analyse-policy':
      void analysePolicy(message.tabId).then(sendResponse);
      return true;
    case 'test-connection':
      void loadSettings()
        .then(checkConnection)
        .then((check: ConnectionCheck) => sendResponse(check));
      return true;
    default:
      return false;
  }
});

chrome.runtime.onInstalled.addListener(() => void paintPausedBadge());
chrome.runtime.onStartup.addListener(() => void paintPausedBadge());
onSettingsChanged(() => void paintPausedBadge());
