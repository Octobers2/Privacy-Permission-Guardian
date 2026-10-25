/**
 * What the service worker keeps between wake-ups.
 *
 *  - analysis state per tab: `chrome.storage.session` (cleared when the browser closes; the popup reads it directly);
 *  - the last finished on-device result per site: `chrome.storage.local`, so reopening a site shows its result instantly.
 *    Entries live 30 days, the same as shared results, and at most `MAX_SAVED` sites are kept.
 */
import { RESULT_TTL_MS } from '@ppg/shared';
import type { AnalysisResult, AnalysisState } from '../analysis/state.ts';
import { RESULTS_STORAGE_KEY, STATE_KEY_PREFIX } from '../messages.ts';

const MAX_SAVED = 50;

export interface StoredState {
  jobId: number;
  state: AnalysisState;
}

export async function readState(tabId: number): Promise<StoredState | null> {
  const key = STATE_KEY_PREFIX + tabId;
  return ((await chrome.storage.session.get(key))[key] as StoredState | undefined) ?? null;
}

export async function writeState(tabId: number, stored: StoredState): Promise<void> {
  await chrome.storage.session.set({ [STATE_KEY_PREFIX + tabId]: stored });
}

export async function clearState(tabId: number): Promise<void> {
  await chrome.storage.session.remove(STATE_KEY_PREFIX + tabId);
}

type Saved = Record<string, { savedAt: number; result: AnalysisResult }>;

export async function saveResult(result: AnalysisResult, now = Date.now()): Promise<void> {
  const saved = ((await chrome.storage.local.get(RESULTS_STORAGE_KEY))[RESULTS_STORAGE_KEY] ?? {}) as Saved;
  saved[result.domain] = { savedAt: now, result };
  const newest = Object.entries(saved)
    .filter(([, v]) => now - v.savedAt < RESULT_TTL_MS)
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, MAX_SAVED);
  await chrome.storage.local.set({ [RESULTS_STORAGE_KEY]: Object.fromEntries(newest) });
}

export async function savedResultFor(domain: string, now = Date.now()): Promise<AnalysisResult | null> {
  const saved = ((await chrome.storage.local.get(RESULTS_STORAGE_KEY))[RESULTS_STORAGE_KEY] ?? {}) as Saved;
  const entry = saved[domain];
  // a result saved by an earlier version has no `money`
  return entry && now - entry.savedAt < RESULT_TTL_MS ? { ...entry.result, money: entry.result.money ?? [] } : null;
}
