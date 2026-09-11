/**
 * The reader, bundled and injected into a rendered page by `render.ts`.
 *
 * It exists as its own entry point so that the server runs *the same*
 * `extractVisibleText` as the extension rather than a second implementation of
 * the hiding rules. Defence layer 1 is measured in `eval/run-injection-eval.ts`;
 * a server-side reimplementation would be measured by nothing.
 *
 * It has to run inside the page because that is where the layout engine is:
 * `getComputedStyle` is the only thing that can see text hidden by a CSS class,
 * which is most of the ways a policy page can hide a sentence from a reader
 * while still handing it to a summariser.
 */
import { extractVisibleText, pickMainContent } from '@ppg/shared/sanitize';

export interface ProbeResult {
  text: string;
  truncated: boolean;
  /** Counted before extraction, to tell a shell apart from an empty document. */
  scriptCount: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __ppgExtract: ((maxChars?: number) => ProbeResult) | undefined;
}

globalThis.__ppgExtract = (maxChars = 24_000) => {
  const { text, truncated } = extractVisibleText(pickMainContent(document), maxChars);
  return { text, truncated, scriptCount: document.querySelectorAll('script').length };
};
