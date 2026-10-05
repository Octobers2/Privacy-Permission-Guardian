/**
 * The runtime half of the page-level signals.
 *
 * `collectPageSignals` in `@ppg/shared` reads what the DOM says: script URLs,
 * URL literals in script text, form actions, declared icons. It cannot see the
 * request a page assembles at runtime and sends four seconds after load, which
 * is exactly how a kit ships what you typed.
 *
 * `PerformanceObserver` can, and it needs no permission and no page code: the
 * resource timeline is a read-only record of what the page requested, and it is
 * already there in the isolated world. It carries the URL and the initiator,
 * never the body — which is the right amount for a rule that only asks "did
 * this page talk to somewhere it has no business talking to?".
 */
import { collectPageSignals, type PageSignals } from '@ppg/shared/page-signals';

/** Enough to characterise a page; a tracker-heavy news site has dozens. */
const MAX_HOSTS = 50;

/** Initiators that can carry what the user typed, as opposed to fetching an asset. */
const SENDING_INITIATORS = new Set(['fetch', 'xmlhttprequest', 'beacon']);

const sendingHosts = new Set<string>();
let observer: PerformanceObserver | null = null;

function record(entries: PerformanceEntryList): boolean {
  let added = false;
  for (const entry of entries) {
    if (sendingHosts.size >= MAX_HOSTS) break;
    const initiator = (entry as PerformanceResourceTiming).initiatorType ?? '';
    if (!SENDING_INITIATORS.has(initiator)) continue;
    try {
      const host = new URL(entry.name).hostname.toLowerCase();
      if (host && !sendingHosts.has(host)) {
        sendingHosts.add(host);
        added = true;
      }
    } catch {
      /* an entry whose name is not a URL tells us nothing */
    }
  }
  return added;
}

/**
 * Starts watching the resource timeline, calling `onNewHost` when the page
 * reaches somewhere it had not reached before.
 *
 * `buffered: true` replays the entries recorded before `document_idle`, which
 * is most of them — a content script that only saw requests made after it
 * loaded would miss the page's own startup traffic.
 */
export function startResourceWatch(onNewHost: () => void): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};

  try {
    observer = new PerformanceObserver((list) => {
      if (record(list.getEntries())) onNewHost();
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    // Not every context supports the buffered resource timeline, and a page
    // that does not is simply scored on what the DOM says.
    observer = null;
  }

  return () => {
    observer?.disconnect();
    observer = null;
  };
}

/** The DOM signals plus whatever the page has been observed sending to. */
export function collectSignals(): PageSignals {
  const signals = collectPageSignals(document, location.href);
  return { ...signals, sendingHosts: [...sendingHosts] };
}

/** Changes whenever there is something new to say, so an unchanged page is not re-sent. */
export function signalsFingerprint(signals: PageSignals): string {
  return [
    signals.exfilSinks.join(','),
    signals.devtoolsBlocks.join(','),
    signals.sendingHosts.length,
    signals.referencedHosts.length,
    signals.iconUrls[0] ?? '',
  ].join('#');
}
