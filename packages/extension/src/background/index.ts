/**
 * MV3 service worker.
 *
 * Holds everything expensive: the rule engine, the public suffix list, the
 * settings schema and (from W2) the policy cache and LLM routing. Loaded once
 * per browser session rather than once per page.
 */
import { registrableDomain, scoreForm, type RuleResult } from '@ppg/shared';
import type { AssessResponse, ExtensionMessage } from '../messages.ts';
import { loadSettings, onSettingsChanged, saveSettings } from '../settings.ts';

const PAUSED_BADGE = '⏸';

async function paintBadge(): Promise<void> {
  const { paused } = await loadSettings();
  await chrome.action.setBadgeText({ text: paused ? PAUSED_BADGE : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
  await chrome.action.setTitle({
    title: paused ? 'Privacy & Permission Guardian — 已暫停' : 'Privacy & Permission Guardian',
  });
}

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
      ? { score: worst.score, verdict: worst.verdict, reasons: worst.hits.map((h) => h.detail) }
      : null,
  };
}

async function allowlistSite(hostname: string): Promise<void> {
  const { allowlist } = await loadSettings();
  await saveSettings({ allowlist: [...new Set([...allowlist, registrableDomain(hostname)])] });
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message?.type === 'assess') {
    void assess(message).then(sendResponse);
    return true; // response is async
  }
  if (message?.type === 'allowlist-site') {
    void allowlistSite(message.hostname).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => void paintBadge());
chrome.runtime.onStartup.addListener(() => void paintBadge());
onSettingsChanged(() => void paintBadge());
