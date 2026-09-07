/**
 * Content script entry point.
 *
 * Runs on every page, so it must stay small and must never pull in a UI
 * framework: the banner is hand-written against the MD3 tokens instead.
 */

console.info('[ppg] content script active on', location.hostname);

export {};
