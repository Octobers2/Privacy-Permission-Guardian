/**
 * MV3 service worker.
 *
 * Owns everything that must survive a page navigation: the per-domain cache,
 * the toolbar badge, and (from W2) routing LLM calls to either the managed
 * backend or the user's own OpenAI-compatible endpoint.
 */

chrome.runtime.onInstalled.addListener(() => {
  console.info('[ppg] service worker installed');
});

export {};
