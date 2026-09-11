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
  ExtractCurrentPageResponse,
  PolicyCandidatesResponse,
  SummaryState,
} from '../messages.ts';
import type { PolicyFailure } from '../offscreen/index.ts';
import { loadSettings, onSettingsChanged, saveSettings } from '../settings.ts';
import { readSummary, writeSummary } from './cache.ts';
import { readInBackgroundTab } from './background-tab.ts';
import { readPolicy } from './offscreen.ts';
import { checkConnection, renderPolicy, summarisePolicy, type RenderUnavailable } from './llm-router.ts';

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

/**
 * Turns per-candidate failures into one sentence that says what to do next.
 *
 * The previous version listed every possible cause as a guess. That is what a
 * message says when nobody measured which one it was, and it sent the user
 * looking in DevTools at a network tab that could never have shown the
 * offscreen document's requests.
 */
function explainFailures(failures: PolicyFailure[], serverReason: RenderUnavailable | null): string {
  // The server is tried first in managed mode, so when it could not even be
  // asked, that is the thing to fix — and it is the one the user can fix.
  if (serverReason === 'no-credentials') {
    return 'Managed 模式未填帳號密碼，所以要由你部機自己讀條款頁 —— 而呢版讀唔到。喺設定頁填返帳號密碼會好好多。';
  }
  if (serverReason === 'rejected') {
    return 'Managed server 唔認得設定頁嗰組帳號密碼，所以冇幫手 render 條款頁，而你部機自己又讀唔到。';
  }
  if (serverReason === 'unreachable') {
    return '連唔到 managed server（開咗 bun run server 未？），而你部機自己讀唔到呢啲條款頁。';
  }

  if (failures.length === 0) return '搵唔到條款文件。';

  const counts = new Map<PolicyFailure['reason'], number>();
  for (const failure of failures) counts.set(failure.reason, (counts.get(failure.reason) ?? 0) + 1);

  if ((counts.get('needs-javascript') ?? 0) > 0) {
    return (
      `搵到 ${failures.length} 條連結。佢哋嘅內容要 JavaScript 先顯示得出，我哋喺背景開咗嗰版等佢自己 render，` +
      '但仍然讀唔到足夠內容（可能係登入牆，或者 render 得太耐）。可以自己撳下面條連結打開再分析。'
    );
  }
  if ((counts.get('fetch-failed') ?? 0) === failures.length) {
    return `搵到 ${failures.length} 條連結，但一條都連唔到。檢查下網絡。`;
  }
  if ((counts.get('http-error') ?? 0) === failures.length) {
    return `搵到 ${failures.length} 條連結，但全部都回應錯誤（可能係登入牆或者已經搬咗）。`;
  }
  return `搵到 ${failures.length} 條連結，但讀返嚟嘅內容太短，唔似一份條款文件。`;
}

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

  // The page the user is on may itself be the policy. Reading it directly is
  // both cheaper and the only thing that works when the document is rendered by
  // JavaScript, because here the site's own scripts have already run.
  let live: ExtractCurrentPageResponse | null = null;
  let candidates: PolicyCandidatesResponse = [];
  try {
    live = (await chrome.tabs.sendMessage(tabId, { type: 'extract-current-page' })) ?? null;
    candidates = (await chrome.tabs.sendMessage(tabId, { type: 'policy-candidates' })) ?? [];
  } catch {
    return {
      status: 'unavailable',
      domain,
      reason: '讀唔到呢一頁。試下重新載入個頁面再嚟。',
    };
  }

  let document: { policyUrl: string; text: string; truncated: boolean } | null = null;
  let failures: PolicyFailure[] = [];
  let serverReason: RenderUnavailable | null = null;

  if (live?.isPolicyPage && live.text.length >= 400) {
    document = { policyUrl: live.policyUrl, text: live.text, truncated: live.truncated };
  } else if (candidates.length === 0) {
    return {
      status: 'unavailable',
      domain,
      reason: '呢一頁冇連去私隱政策或者服務條款。',
    };
  } else {
    // The server first, in managed mode. It runs a real browser, so the pages
    // that need one — anything rendered on the client, which by now is most of
    // the large sites — are readable on the first try instead of after two
    // failed attempts here. It costs this machine nothing and opens no tab.
    const rendered = await renderPolicy(settings, candidates);
    if (rendered.ok) {
      document = rendered.response.policy;
      // Its failures speak the same vocabulary as the offscreen reader's, apart
      // from two only it can produce; both are reported the same way.
      failures = rendered.response.failures.map((failure) => ({
        url: failure.url,
        reason: failure.reason === 'blocked-host' || failure.reason === 'render-unavailable'
          ? 'fetch-failed'
          : failure.reason,
      }));
    } else {
      serverReason = rendered.reason;
    }

    // The browser's own ladder: still the only path in BYOK mode, still the
    // only one with the user's session, and the fallback whenever the server
    // could not help. Rung 1 fetches and renders without running any script.
    if (!document) {
      const read = await readPolicy(candidates);
      document = read.policy;
      if (read.failures.length > 0) failures = read.failures;

      // Rung 2: what is left is the client-rendered case, and the only way to
      // read those here is to let the site render itself — in its own origin,
      // in a tab the user never sees.
      if (!document) {
        const needsJavascript = read.failures.filter(
          (failure) => failure.reason === 'needs-javascript',
        );
        for (const failure of needsJavascript.slice(0, 3)) {
          const inTab = await readInBackgroundTab(failure.url);
          if (inTab) {
            document = {
              policyUrl: inTab.policyUrl,
              text: inTab.text,
              truncated: inTab.truncated,
            };
            break;
          }
        }
      }
    }

    // The server did read it, or a fallback did; either way there is nothing to
    // explain about the server.
    if (document) serverReason = null;
  }

  if (!document) {
    return {
      status: 'unavailable',
      domain,
      reason: explainFailures(failures, serverReason),
      links: [...new Set([...failures.map((failure) => failure.url), ...candidates])].slice(0, 5),
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
