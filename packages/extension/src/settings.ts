/**
 * Settings storage, shared by the content script, the service worker and the
 * options page.
 *
 * Everything lives in `chrome.storage.local` rather than `sync`: the API key is
 * in here, and syncing it to every machine signed into the same browser profile
 * is not a decision this extension should make on the user's behalf.
 */
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '@ppg/shared';

const KEY = 'settings';

/**
 * The `maxTokens` default before reasoning models were handled.
 *
 * A stored 1200 cannot be a deliberate choice: there was no way to change it in
 * the options page when that default shipped. It silently broke every reasoning
 * model — the thinking consumed the entire allowance and the answer came back
 * empty — so a stored copy of it is adopted forward rather than preserved. A
 * value the user actually typed is left alone.
 */
const SUPERSEDED_MAX_TOKENS = 1_200;

function migrate(stored: Partial<Settings>): Partial<Settings> {
  if (stored.maxTokens === SUPERSEDED_MAX_TOKENS) {
    const { maxTokens: _superseded, ...rest } = stored;
    return rest;
  }
  return stored;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const parsed = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...migrate(stored[KEY] ?? {}) });
  // A settings object that fails its own schema means a partial write or an
  // older shape; falling back beats leaving the extension in a broken state.
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = SettingsSchema.parse({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** Calls back whenever settings change, including from another extension page. */
export function onSettingsChanged(callback: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    void loadSettings().then(callback);
  });
}
