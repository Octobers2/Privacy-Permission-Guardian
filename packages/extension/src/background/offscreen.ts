/**
 * Owns the offscreen document: the one place that has both a rendering engine (to read terms pages with their CSS applied)
 * and a lifetime longer than a service worker's (to hold the on-device model through a minutes-long analysis).
 *
 * Chrome allows one offscreen document per extension, so reading pages and running the model share it.
 */
import type { PolicyReadResult } from '../offscreen/index.ts';
import type { AnalyseTextRequest } from '../messages.ts';

const PATH = 'offscreen.html';

let creating: Promise<void> | null = null;

async function exists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] });
  return contexts.length > 0;
}

/** Idempotent, and safe to call concurrently — creating twice is an error. */
export async function ensureOffscreen(): Promise<void> {
  if (await exists()) return;
  if (creating) return creating;

  creating = chrome.offscreen
    .createDocument({
      url: PATH,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification:
        'Render fetched terms-of-service pages so hidden text can be identified, and keep the on-device classification model loaded while a document is analysed.',
    })
    .finally(() => {
      creating = null;
    });

  return creating;
}

export async function readPolicy(urls: string[]): Promise<PolicyReadResult> {
  if (urls.length === 0) return { policy: null, failures: [] };
  await ensureOffscreen();
  return (await chrome.runtime.sendMessage({ type: 'read-policy', urls })) ?? { policy: null, failures: [] };
}

export async function startAnalysisInOffscreen(job: AnalyseTextRequest['job']): Promise<void> {
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ type: 'analyse-text', job } satisfies AnalyseTextRequest);
}
