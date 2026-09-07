/**
 * Owns the offscreen document that reads policy pages.
 *
 * A service worker has neither a DOM nor a rendering engine, and a content
 * script's requests are governed by the page's CSP. An offscreen document is an
 * extension page with both, so that is where fetching and rendering happen.
 */
import type { PolicyReadResult } from '../offscreen/index.ts';

const PATH = 'offscreen.html';

let creating: Promise<void> | null = null;

async function exists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  return contexts.length > 0;
}

/** Idempotent, and safe to call concurrently — creating twice is an error. */
async function ensure(): Promise<void> {
  if (await exists()) return;
  if (creating) return creating;

  creating = chrome.offscreen
    .createDocument({
      url: PATH,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification:
        'Render a fetched privacy policy so that text hidden with CSS can be identified before it is summarised.',
    })
    .finally(() => {
      creating = null;
    });

  return creating;
}

export async function readPolicy(urls: string[]): Promise<PolicyReadResult> {
  if (urls.length === 0) return { policy: null, failures: [] };
  await ensure();
  return (
    (await chrome.runtime.sendMessage({ type: 'read-policy', urls })) ?? { policy: null, failures: [] }
  );
}
