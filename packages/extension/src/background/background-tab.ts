/**
 * Reads a policy page that only exists after its own JavaScript has run.
 *
 * The offscreen reader deliberately executes nothing, which is right for the
 * common case but leaves the large sites unreadable: Meta, Google and most of
 * the rest serve a shell and fill it in on the client. Telling the user to go
 * and open the page themselves would give up on the one thing this extension
 * is for.
 *
 * So the page is opened in an ordinary background tab. The site's scripts run
 * in the site's own origin, exactly as they would if the user had clicked the
 * link — which makes this *less* exposed than the sandboxed iframe, not more:
 * nothing attacker-controlled comes near the extension's origin. The content
 * script then reads the rendered DOM through the same sanitiser, with real
 * computed styles.
 *
 * It is the escalation, not the default: executing a site's scripts is
 * something to do when there is no other way to read the document, and the
 * cheap path is tried first.
 */
import type { ExtractCurrentPageResponse } from '../messages.ts';

/**
 * Bounded on purpose: a page that never reaches `complete` should not hold the
 * popup for half a minute. Two candidates at this budget is about eleven
 * seconds of waiting in the worst case, which is the most a "reading the
 * policy…" spinner can reasonably ask for.
 */
const LOAD_TIMEOUT_MS = 11_000;
/** Client rendering finishes some time after `complete`; poll rather than guess. */
const RENDER_ATTEMPTS = 6;
const RENDER_INTERVAL_MS = 700;
const MIN_USEFUL_CHARS = 400;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function waitForLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, LOAD_TIMEOUT_MS);

    function finish(): void {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    function listener(updatedTabId: number, info: chrome.tabs.TabChangeInfo): void {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    }

    chrome.tabs.onUpdated.addListener(listener);
    // The tab may already be complete by the time the listener is attached.
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish();
    });
  });
}

/**
 * Opens `url` out of sight, waits for it to render, and returns its text.
 *
 * The tab is closed on every path, including when the extraction throws — a
 * leaked background tab on somebody's browser would be a rude thing for a
 * privacy tool to leave behind.
 */
export async function readInBackgroundTab(url: string): Promise<ExtractCurrentPageResponse | null> {
  if (!/^https?:\/\//i.test(url)) return null;

  const tab = await chrome.tabs.create({ url, active: false }).catch(() => null);
  if (!tab?.id) return null;
  const tabId = tab.id;

  try {
    await waitForLoad(tabId);

    let best: ExtractCurrentPageResponse | null = null;
    for (let attempt = 0; attempt < RENDER_ATTEMPTS; attempt++) {
      await sleep(RENDER_INTERVAL_MS);
      const extracted: ExtractCurrentPageResponse | null = await chrome.tabs
        .sendMessage(tabId, { type: 'extract-current-page', force: true })
        .catch(() => null);
      if (!extracted) continue;

      // Keep the longest seen: a single-page app can render in stages, and an
      // early read may catch a spinner and a cookie banner.
      if (!best || extracted.text.length > best.text.length) best = extracted;
      if (best.text.length >= MIN_USEFUL_CHARS && extracted.text.length === best.text.length) break;
    }

    return best && best.text.length >= MIN_USEFUL_CHARS ? best : null;
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}
