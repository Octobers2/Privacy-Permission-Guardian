/**
 * Bundled into the page by `run-injection-eval.ts` so the sanitiser can be
 * measured where it actually runs.
 *
 * `linkedom`, which the rest of the harness uses, has no layout engine: it
 * cannot resolve a CSS class, so it cannot see white-on-white text and would
 * report the extension as weaker than it is. This runs the real production
 * function against a real rendering engine.
 */
import { extractVisibleText, pickMainContent } from '@ppg/shared/sanitize';

declare global {
  // eslint-disable-next-line no-var
  var __ppgExtract: (() => string) | undefined;
}

globalThis.__ppgExtract = () => extractVisibleText(pickMainContent(document)).text;
