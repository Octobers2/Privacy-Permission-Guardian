/**
 * Preferences for the v2 flow (model choice, server, remote summary, contributor account, form-warning pause list).
 *
 * `chrome.storage.local`, never `sync`: the sign-in token and any BYOK key are in here, and copying them to every
 * machine on the same browser profile is not a decision this extension should make for the user.
 */
import { z } from 'zod';

import { PREFS_STORAGE_KEY } from './messages.ts';

export const PREFS_KEY = PREFS_STORAGE_KEY;

/** Where the backend lives. Set at build time with VITE_PPG_SERVER; the user can change it on the setup/options page. */
export const DEFAULT_SERVER: string = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_PPG_SERVER ?? 'http://localhost:8787';

export const SUMMARY_MODES = ['off', 'server', 'byok'] as const;

/**
 * Where findings come from. `device`: an on-device model reads the terms (the default). `shared`: no model is installed, and the
 * extension only looks up what others have already read, which needs no GPU.
 */
export const ENGINE_MODES = ['device', 'shared'] as const;

export const PrefsSchema = z
  .object({
    setupDone: z.boolean().default(false),
    serverUrl: z.string().url().default(DEFAULT_SERVER),
    mode: z.enum(ENGINE_MODES).default('device'),
    /** Manifest id of the downloaded model, or null before setup (and always null in shared mode). */
    modelId: z.string().nullable().default(null),
    /** Plain-language summaries: off, from the backend, or from the user's own OpenAI-compatible endpoint. */
    summary: z.enum(SUMMARY_MODES).default('off'),
    byok: z.object({ baseUrl: z.string().default(''), apiKey: z.string().default(''), model: z.string().default('') }).default({}),
    /** Present when the user signed in as a contributor (allowed to share results). */
    account: z.object({ username: z.string(), token: z.string(), expiresAt: z.number() }).nullable().default(null),
    paused: z.boolean().default(false),
    /**
     * Whether the worker may fetch a page's favicon to compare it with well-known brand icons. It is the only form-warning check that
     * makes a request of its own, so it has a switch. The request goes to the site the user is already on, and only on a page that
     * has already scored something.
     */
    faviconCheck: z.boolean().default(true),
    /** Registrable domains where the form warning stays quiet. */
    allowlist: z.array(z.string()).default([]),
  })
  .strict();
export type Prefs = z.infer<typeof PrefsSchema>;

export const DEFAULT_PREFS: Prefs = PrefsSchema.parse({});

/** A stored value that no longer matches the schema (older version, partial write) falls back to defaults, field by field. */
export function parsePrefs(stored: unknown): Prefs {
  const whole = PrefsSchema.safeParse(stored ?? {});
  if (whole.success) return whole.data;
  const salvaged: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(PrefsSchema.shape)) {
    const value = (stored as Record<string, unknown> | undefined)?.[key];
    if (value !== undefined && schema.safeParse(value).success) salvaged[key] = value;
  }
  return PrefsSchema.parse(salvaged);
}

export async function loadPrefs(): Promise<Prefs> {
  return parsePrefs((await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY]);
}

export async function savePrefs(patch: Partial<Prefs>): Promise<Prefs> {
  const next = PrefsSchema.parse({ ...(await loadPrefs()), ...patch });
  await chrome.storage.local.set({ [PREFS_KEY]: next });
  return next;
}

export function onPrefsChanged(callback: (prefs: Prefs) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[PREFS_KEY]) callback(parsePrefs(changes[PREFS_KEY].newValue));
  });
}

/** The signed-in account, or null once its token has expired. */
export function activeAccount(prefs: Prefs, now = Date.now()): Prefs['account'] {
  return prefs.account && prefs.account.expiresAt > now ? prefs.account : null;
}

/** Whether setup has been completed in a way that lets the popup do something: a model is installed, or shared-only mode was chosen. */
export function isReady(prefs: Prefs): boolean {
  return prefs.setupDone && (prefs.mode === 'shared' || prefs.modelId !== null);
}
