/**
 * Watches the page for forms and reports them when the set of forms changes.
 *
 * No scoring here — that lives in the service worker (see `../messages.ts`).
 * This file only decides *when* to look and avoids reporting the same page
 * layout twice.
 *
 * It watches the page-level signals on the same schedule, because they change
 * independently: a kit whose form never changes can still start posting to a
 * new host four seconds after load, and a fingerprint built only from the form
 * set would call that page already seen.
 */
import { extractForms } from '@ppg/shared/extract-form';
import { EMPTY_PAGE_SIGNALS, type PageSignals } from '@ppg/shared/page-signals';
import type { FormObservation } from '@ppg/shared/schemas';

/**
 * Identifies the page's forms by their shape, so a re-render that rebuilds the
 * same inputs does not trigger a second round trip — and so a form that gains a
 * credit card field partway through does.
 */
export function fingerprintOf(observations: FormObservation[]): string {
  return observations
    .map((observation) => {
      const fields = observation.form.fields
        .map((f) => `${f.type}:${f.name || f.id || f.label}`)
        .sort()
        .join('|');
      return `${observation.form.actionOrigin ?? ''}#${fields}`;
    })
    .sort()
    .join('||');
}

export function scanDocument(): FormObservation[] {
  return extractForms(document, location.href, document.title);
}

/**
 * Calls `onChange` with the page's forms now, and again whenever they change.
 *
 * Single-page apps mount their login and checkout forms long after
 * `document_idle`, so a one-shot scan would miss most of them. The observer is
 * debounced because pages that animate mutate the DOM continuously.
 *
 * The returned handle carries `refresh()` so something outside the DOM — the
 * resource-timing watcher — can ask for a re-assessment without waiting for a
 * mutation that may never come.
 */
export interface DocumentWatch {
  dispose(): void;
  refresh(): void;
}

export interface WatchOptions {
  debounceMs?: number;
  /** The page-level signals as they stand right now. */
  signalsOf?: () => PageSignals;
  /** Distinguishes one set of page signals from another; see `content/page-signals.ts`. */
  fingerprintSignals?: (signals: PageSignals) => string;
}

export function watchDocument(
  onChange: (observations: FormObservation[], signals: PageSignals) => void,
  options: WatchOptions = {},
): DocumentWatch {
  const {
    debounceMs = 400,
    signalsOf = () => EMPTY_PAGE_SIGNALS,
    fingerprintSignals = () => '',
  } = options;

  let lastFingerprint: string | null = null;

  const run = () => {
    const observations = scanDocument();
    const signals = signalsOf();
    const fingerprint = `${fingerprintOf(observations)}##${fingerprintSignals(signals)}`;
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    onChange(observations, signals);
  };

  run();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return {
    refresh: schedule,
    dispose: () => {
      clearTimeout(timer);
      observer.disconnect();
      lastFingerprint = null;
    },
  };
}
