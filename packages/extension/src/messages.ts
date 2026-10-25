/**
 * The message protocol between the content script, the service worker, the offscreen document and the extension pages.
 *
 * Who does what, and why:
 *  - the content script does DOM work only (finding terms links, reading the live page, the form scan): the code that
 *    runs on every page the user visits stays small;
 *  - the service worker has the tabs API, so it finds and reads the document, then hands the text over;
 *  - the offscreen document stays alive for minutes (a service worker is stopped after 30 s idle), so it owns the model and
 *    runs the analysis; it reports progress back to the worker, which keeps it in `chrome.storage.session` for the popup.
 *
 * Types and two string constants only: no runtime import, so this adds nothing to any bundle.
 */
import type { FormObservation, PageSignals, Verdict } from '@ppg/shared';
import type { Job } from './analysis/analyzer.ts';
import type { AnalysisResult, AnalysisState } from './analysis/state.ts';

export const PREFS_STORAGE_KEY = 'ppg-prefs';
export const STATE_KEY_PREFIX = 'analysis:';
export const RESULTS_STORAGE_KEY = 'ppg-results';

/* ------------------------------------------------ content script -> worker */

export interface AssessRequest {
  type: 'assess';
  observations: FormObservation[];
  /**
   * What the page itself is doing: where it ships data, what its icon claims to
   * be, whether it is fighting DevTools.
   *
   * This travels to the worker and stops there. It is deliberately not part of
   * `FormAssessRequest`, which is the shape that leaves the browser — the model
   * keeps getting rule ids, not the list of hosts a page talked to.
   */
  signals: PageSignals;
}

export interface AllowlistSiteRequest {
  type: 'allowlist-site';
  hostname: string;
}

export interface AssessResponse {
  paused: boolean;
  /** The user asked not to be warned on this site. */
  allowed: boolean;
  /**
   * The most alarming finding on the page, or null when nothing is worth saying.
   *
   * `kind` decides the headline: a warning about a form says "do not type into
   * this form", while one raised by the page alone — a kit whose inputs are
   * loose `contenteditable` divs — has no form to point at.
   */
  worst: { score: number; verdict: Verdict; reasons: string[]; kind: 'form' | 'page' } | null;
}

/* --------------------------------------------------- popup/options -> worker */

export interface GetStateRequest {
  type: 'get-state';
  tabId: number;
}

export interface AnalyseRequest {
  type: 'analyse';
  tabId: number;
}

/** "Find similar cases": the user asked to compare this page's flagged clauses with other sites'. Nothing is sent before this. */
export interface FindSimilarRequest {
  type: 'find-similar';
  tabId: number;
}

/** The user's answer to "Share this result?". The upload happens in the worker, from the result it already holds. */
export interface ShareResultRequest {
  type: 'share-result';
  tabId: number;
  decision: 'share' | 'decline';
}

/**
 * "This site has no terms", sent only when the user presses Report. From the page the worker takes the address from the browser's
 * own record of the tab, never from the message; from the popup, `tabId` says which tab.
 */
export interface ReportMissingTermsRequest {
  type: 'report-missing-terms';
  tabId?: number;
  /** Addresses the sender looked at for terms. The server keeps only those on the same site. */
  tried?: string[];
}
export interface ReportMissingTermsResponse {
  ok: boolean;
  message: string;
}

/* ---------------------------------------------------- worker -> content script */

/** The terms were looked for and not found: warn on the page itself. `tried` is what the report would carry. */
export interface ShowNoTermsRequest {
  type: 'show-no-terms';
  tried: string[];
  /** What the model found on the page itself (names of clause types), if anything. */
  suspicious: string[];
}

/** Asks the content script where the terms might be. Only URLs: reading them needs the offscreen document. */
export interface PolicyCandidatesRequest {
  type: 'policy-candidates';
}
/** `links` were found on the page; `guesses` are conventional addresses tried when the page links to nothing. */
export interface PolicyCandidatesResponse {
  links: string[];
  guesses: string[];
}

/** Reads the page the user is actually looking at, scripts already run. */
export interface ExtractCurrentPageRequest {
  type: 'extract-current-page';
  /** Read the page even when it does not look like a terms document (a background tab the worker already chose). */
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

export interface AnalyseTextRequest {
  type: 'analyse-text';
  job: Job;
}

/* ------------------------------------------------ offscreen page -> worker */

export interface AnalysisStateMessage {
  type: 'analysis-state';
  tabId: number;
  jobId: number;
  state: AnalysisState;
}

/** A finished on-device result, to keep so the popup can show it instantly on the next visit. */
export interface SaveResultMessage {
  type: 'save-result';
  result: AnalysisResult;
}

export type ExtensionMessage =
  | AssessRequest
  | AllowlistSiteRequest
  | GetStateRequest
  | AnalyseRequest
  | ShareResultRequest
  | FindSimilarRequest
  | ReportMissingTermsRequest
  | ShowNoTermsRequest
  | PolicyCandidatesRequest
  | ExtractCurrentPageRequest
  | ReadPolicyRequest
  | AnalyseTextRequest
  | AnalysisStateMessage
  | SaveResultMessage;
