/**
 * The message protocol between the content script, the service worker and the
 * extension pages.
 *
 * Scoring and model calls deliberately happen in the worker, not in the page.
 * The rule engine pulls in the public suffix list and zod, which together weigh
 * about 330 kB — acceptable once per browser session in the worker,
 * indefensible on every page the user visits. The content script is left with
 * DOM work, which is a few kilobytes.
 *
 * Types only; no runtime import, so this file adds nothing to either bundle.
 */
import type { ConnectionCheck, FormObservation, PolicySummary, Verdict } from '@ppg/shared';

export const SETTINGS_STORAGE_KEY = 'settings';

/* ------------------------------------------------ content script -> worker */

export interface AssessRequest {
  type: 'assess';
  observations: FormObservation[];
}

export interface AllowlistSiteRequest {
  type: 'allowlist-site';
  hostname: string;
}

export interface AssessResponse {
  paused: boolean;
  /** The most alarming form on the page, or null when nothing is worth saying. */
  worst: { score: number; verdict: Verdict; reasons: string[] } | null;
}

/* --------------------------------------------------- popup/options -> worker */

export interface GetSummaryRequest {
  type: 'get-summary';
  tabId: number;
}

export interface AnalysePolicyRequest {
  type: 'analyse-policy';
  tabId: number;
}

export interface TestConnectionRequest {
  type: 'test-connection';
}

/**
 * What the popup renders.
 *
 * `unavailable` is a first-class outcome, not an error: plenty of sites have no
 * findable policy, and saying so is better than inventing a summary of a cookie
 * banner.
 */
export type SummaryState =
  | { status: 'idle'; domain: string }
  | { status: 'working'; domain: string }
  | { status: 'ready'; domain: string; cached: boolean; summary: PolicySummary }
  | { status: 'unavailable'; domain: string; reason: string }
  | { status: 'error'; domain: string; message: string };

/* ---------------------------------------------------- worker -> content script */

export interface ScoutPolicyRequest {
  type: 'scout-policy';
}

export interface ScoutPolicyResponse {
  policyUrl: string;
  text: string;
  truncated: boolean;
}

export type ExtensionMessage =
  | AssessRequest
  | AllowlistSiteRequest
  | GetSummaryRequest
  | AnalysePolicyRequest
  | TestConnectionRequest
  | ScoutPolicyRequest;

export type ConnectionCheckResponse = ConnectionCheck;
