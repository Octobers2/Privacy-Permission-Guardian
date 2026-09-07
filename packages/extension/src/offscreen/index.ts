/**
 * Reads policy pages, in the only context where both halves of the job work.
 *
 * Two things went wrong when this lived in the content script:
 *
 *   1. A content script's `fetch` is subject to the *page's* CSP. GitHub and
 *      Reddit both set a `connect-src` strict enough to block it — even for a
 *      same-origin request to their own privacy page — so the policy could
 *      never be read on exactly the kind of site that matters.
 *
 *   2. `getComputedStyle` returns empty strings for a document produced by
 *      `DOMParser`, because it has no browsing context. Every style-based check
 *      in the sanitiser silently did nothing, so text hidden with a CSS class
 *      (white-on-white, `display:none` from a stylesheet) went straight to the
 *      model.
 *
 * An offscreen document is an extension page: no page CSP applies to its
 * requests, and it has a real rendering engine. The fetched HTML is put into a
 * sandboxed iframe *without* `allow-scripts`, so nothing in it executes, but the
 * stylesheets do load and `getComputedStyle` answers truthfully.
 */
import { extractVisibleText, pickMainContent } from '@ppg/shared/sanitize';

const MAX_POLICY_CHARS = 24_000;
const RENDER_TIMEOUT_MS = 8_000;

export interface RenderedPolicy {
  policyUrl: string;
  text: string;
  truncated: boolean;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/**
 * Renders fetched HTML and returns what a reader would see.
 *
 * `sandbox` without `allow-scripts` is what makes this safe: the document is
 * laid out and styled but nothing in it runs. `allow-same-origin` is required
 * to reach `contentDocument`, and is only dangerous in combination with
 * `allow-scripts`, which is exactly what is withheld.
 */
async function renderAndExtract(html: string, baseUrl: string): Promise<{ text: string; truncated: boolean }> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1024px;height:2000px;border:0';

  // A <base> so the page's own stylesheets resolve; without them, class-based
  // hiding is invisible again and we are back to the bug this file exists for.
  frame.srcdoc = `<base href="${escapeAttribute(baseUrl)}">${html}`;

  const loaded = new Promise<void>((resolve) => {
    frame.addEventListener('load', () => resolve(), { once: true });
    setTimeout(resolve, RENDER_TIMEOUT_MS);
  });

  document.body.append(frame);
  try {
    await loaded;
    // Give linked stylesheets a moment to apply before styles are read.
    await new Promise((done) => setTimeout(done, 250));

    const doc = frame.contentDocument;
    if (!doc) return { text: '', truncated: false };
    const { text, truncated } = extractVisibleText(pickMainContent(doc), MAX_POLICY_CHARS, (element) => {
      try {
        return frame.contentWindow?.getComputedStyle(element) ?? null;
      } catch {
        return null;
      }
    });
    return { text, truncated };
  } finally {
    frame.remove();
  }
}

async function readPolicyAt(url: string): Promise<RenderedPolicy | null> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'include', redirect: 'follow' });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  if (!(response.headers.get('content-type') ?? '').includes('html')) return null;

  const html = await response.text();
  const { text, truncated } = await renderAndExtract(html, response.url || url);

  // A "policy page" of two sentences is a cookie wall or a redirect stub.
  if (text.length < 400) return null;

  return { policyUrl: response.url || url, text, truncated };
}

/** Tries each candidate in order and returns the first that reads like a document. */
export async function readFirstPolicy(urls: string[]): Promise<RenderedPolicy | null> {
  for (const url of urls) {
    const found = await readPolicyAt(url);
    if (found) return found;
  }
  return null;
}

chrome.runtime.onMessage.addListener((message: { type?: string; urls?: string[] }, _sender, sendResponse) => {
  if (message?.type !== 'read-policy') return false;
  void readFirstPolicy(message.urls ?? []).then(sendResponse);
  return true;
});
