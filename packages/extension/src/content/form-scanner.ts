/**
 * Watches the page for forms and reports them when the set of forms changes.
 *
 * No scoring here — that lives in the service worker (see `../messages.ts`).
 * This file only decides *when* to look and avoids reporting the same page
 * layout twice.
 */
import { extractForms } from '@ppg/shared/extract-form';
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
 */
export function watchDocument(
  onChange: (observations: FormObservation[]) => void,
  debounceMs = 400,
): () => void {
  let lastFingerprint: string | null = null;

  const run = () => {
    const observations = scanDocument();
    const fingerprint = fingerprintOf(observations);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    onChange(observations);
  };

  run();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return () => {
    clearTimeout(timer);
    observer.disconnect();
    lastFingerprint = null;
  };
}
