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
  /** `links` lets the popup offer the pages it found but could not read. */
  | { status: 'unavailable'; domain: string; reason: string; links?: string[] }
  | { status: 'error'; domain: string; message: string };

/* ---------------------------------------------------- worker -> content script */

/**
 * Asks the content script where the policy might be.
 *
 * Only the URLs: reading them needs an extension context (the page's CSP blocks
 * a content script's fetch) and a browsing context (a DOMParser document
 * resolves no styles), which is what the offscreen document provides.
 */
export interface PolicyCandidatesRequest {
  type: 'policy-candidates';
}

export type PolicyCandidatesResponse = string[];

/** Reads the page the user is actually looking at, scripts already run. */
export interface ExtractCurrentPageRequest {
  type: 'extract-current-page';
  /**
   * Read the page even when it does not look like a policy document.
   *
   * The worker asks the *active* tab speculatively — usually an ordinary page
   * whose text it will discard — so by default the content script answers those
   * without walking the DOM. The background-tab reader has already decided the
   * URL is a policy candidate, and some of them are named in a way the URL
   * pattern cannot recognise ("Privacy Policy" linking to `/legal-center`).
   */
  force?: boolean;
}

export interface ExtractCurrentPageResponse {
  isPolicyPage: boolean;
  policyUrl: string;
  text: string;
  truncated: boolean;
}

/* ------------------------------------------------ worker -> offscreen page */

export interface ReadPolicyRequest {
  type: 'read-policy';
  urls: string[];
}

export interface ReadPolicyResponse {
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
  | PolicyCandidatesRequest
  | ExtractCurrentPageRequest
  | ReadPolicyRequest;

export type ConnectionCheckResponse = ConnectionCheck;
