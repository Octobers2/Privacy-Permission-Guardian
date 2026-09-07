/**
 * The content script <-> service worker protocol.
 *
 * Scoring deliberately happens in the worker, not in the page. The rule engine
 * pulls in the public suffix list and zod, which together weigh about 330 kB —
 * acceptable once per browser session in the worker, indefensible on every page
 * the user visits. The content script is left with DOM extraction and drawing,
 * which is a few kilobytes.
 *
 * Types only; no runtime import, so this file adds nothing to either bundle.
 */
import type { FormObservation, Verdict } from '@ppg/shared';

export interface AssessRequest {
  type: 'assess';
  observations: FormObservation[];
}

export interface AllowlistSiteRequest {
  type: 'allowlist-site';
  hostname: string;
}

export type ExtensionMessage = AssessRequest | AllowlistSiteRequest;

export interface AssessResponse {
  paused: boolean;
  /** The most alarming form on the page, or null when nothing is worth saying. */
  worst: { score: number; verdict: Verdict; reasons: string[] } | null;
}

export const SETTINGS_STORAGE_KEY = 'settings';
