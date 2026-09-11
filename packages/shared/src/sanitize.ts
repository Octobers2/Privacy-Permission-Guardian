/**
 * Turns a web page into text that is safe to put in front of a model.
 *
 * Everything a policy page contains is attacker-controlled. A site that would
 * rather not be summarised honestly can hide an instruction in white-on-white
 * text, in a `display: none` div, or in an HTML comment, and a naive
 * `document.body.textContent` hands it straight to the model.
 *
 * This module is the first of the five defences (see docs/threat-model.md):
 * remove what a human reader cannot see, then label whatever is left as data.
 * The others — schema validation, verbatim quote checking, and never rendering
 * model output as HTML — live in `schemas.ts`, below, and in the UI.
 */

/** Elements whose content is never part of what a reader sees. */
const NEVER_VISIBLE_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'head',
]);

/** The same list as a selector, for the DOM-mutating path below. */
const NEVER_VISIBLE = [...NEVER_VISIBLE_TAGS].join(', ');

/**
 * Elements a reader sees a line break after.
 *
 * `textContent` concatenates with no separator at all, so a page whose markup
 * carries no whitespace between tags — which is every client-rendered page,
 * because the framework emits it — comes out as `…share your data.We keep it…`.
 * The model then reads run-together sentences, and a quote it copies out of them
 * will not match the source once the page is re-read. Emitting the break the
 * reader actually sees costs one `Set` lookup per element.
 */
const BLOCK_LEVEL_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog', 'div', 'dl',
  'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** Inline styles that hide an element from a sighted reader. */
const HIDING_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?!\s*\.\d*[1-9])|font-size\s*:\s*0(?:px|em|rem)?)\s*(?:;|$)/i;

/** Inline styles that park an element outside the viewport. */
const OFFSCREEN_STYLE =
  /(?:left|top|right|bottom|text-indent)\s*:\s*-\s*(?:\d{4,}|[1-9]\d{2,})\s*(?:px|em|rem|%)/i;

export interface SanitizeStats {
  /** How many elements were removed for being invisible. */
  hiddenRemoved: number;
  /** How many were removed for being non-content (script, style, ...). */
  markupRemoved: number;
  commentsRemoved: number;
}

/** Reads computed styles when a layout engine is available. */
type StyleReader = (element: Element) => CSSStyleDeclaration | null;

function defaultStyleReader(): StyleReader {
  // linkedom, which the evaluation harness uses, has no layout engine; there
  // the inline-style checks below do the work on their own.
  const view = typeof globalThis !== 'undefined' ? (globalThis as { getComputedStyle?: unknown }) : undefined;
  if (typeof view?.getComputedStyle !== 'function') return () => null;
  return (element) => {
    try {
      return (view.getComputedStyle as (el: Element) => CSSStyleDeclaration)(element);
    } catch {
      return null;
    }
  };
}

/** Parses `rgb(…)` / `rgba(…)`, which is what getComputedStyle always returns. */
function parseRgb(value: string): [number, number, number, number] | null {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
}

function relativeLuminance([r, g, b]: [number, number, number, number]): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * The first opaque background colour up the tree, or null if nothing sets one.
 *
 * Null matters: a page that paints its background with an image or a gradient
 * has no colour to compare against, and guessing white there would let us
 * delete white text that a reader can see perfectly well.
 */
function resolvedBackground(element: Element, readStyle: StyleReader): [number, number, number, number] | null {
  let node: Element | null = element;
  while (node) {
    const style = readStyle(node);
    if (style) {
      if (style.backgroundImage && style.backgroundImage !== 'none') return null;
      const colour = parseRgb(style.backgroundColor ?? '');
      if (colour && colour[3] > 0.9) return colour;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Text painted in its own background colour.
 *
 * White-on-white is the one hiding technique that is invisible to a reader *and*
 * survives every attribute-level check, so it is worth the extra work. The
 * threshold is deliberately at the very bottom of the contrast scale: 1.0 is
 * identical colours, and WCAG's minimum for body text is 4.5. Anything above
 * 1.15 might be a design choice, and deleting it would remove real content.
 */
function isInvisibleByColour(element: Element, readStyle: StyleReader): boolean {
  const style = readStyle(element);
  if (!style) return false;
  if (!(element.textContent ?? '').trim()) return false;

  const foreground = parseRgb(style.color ?? '');
  if (!foreground || foreground[3] < 0.1) return foreground !== null;

  const background = resolvedBackground(element, readStyle);
  if (!background) return false;

  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05) < 1.15;
}

function isHidden(element: Element, readStyle: StyleReader): boolean {
  if (element.hasAttribute('hidden')) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;

  const inline = element.getAttribute('style') ?? '';
  if (HIDING_STYLE.test(inline) || OFFSCREEN_STYLE.test(inline)) return true;

  const computed = readStyle(element);
  if (!computed) return false;
  if (computed.display === 'none' || computed.visibility === 'hidden') return true;
  if (computed.opacity === '0') return true;
  if (parseFloat(computed.fontSize || '16') === 0) return true;
  if (isInvisibleByColour(element, readStyle)) return true;

  return false;
}

/** Walks the tree collecting comment nodes, which querySelectorAll cannot reach. */
function collectComments(root: Node): Node[] {
  const comments: Node[] = [];
  const visit = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) comments.push(child);
      else if (child.nodeType === 1) visit(child);
    }
  };
  visit(root);
  return comments;
}

/**
 * Strips everything a reader cannot see, in place.
 *
 * **Nothing in the extension calls this.** `collectVisibleText` below answers
 * the same question without touching the tree, and that is what the pipeline
 * uses; this remains because `eval/run-injection-eval.ts` reports a comparison
 * column for an implementation that has no rendering engine, and because it is
 * the most direct test of the hiding predicates.
 *
 * It was once on the live page the user was looking at, and that was the bug
 * that made Instagram and Facebook lose half their styling mid-analysis: it
 * deletes every `<style>` in the body and every `aria-hidden` subtree, and a
 * framework that expects to find them again does not survive it.
 */
export function stripInvisibleContent(root: Document | Element, readStyle = defaultStyleReader()): SanitizeStats {
  const stats: SanitizeStats = { hiddenRemoved: 0, markupRemoved: 0, commentsRemoved: 0 };

  for (const element of [...root.querySelectorAll(NEVER_VISIBLE)]) {
    element.remove();
    stats.markupRemoved++;
  }

  for (const comment of collectComments(root)) {
    comment.parentNode?.removeChild(comment);
    stats.commentsRemoved++;
  }

  for (const element of [...root.querySelectorAll('*')]) {
    // The element may already have gone with an ancestor.
    if (!element.isConnected && root.contains && !root.contains(element)) continue;
    if (isHidden(element, readStyle)) {
      element.remove();
      stats.hiddenRemoved++;
    }
  }

  return stats;
}

export interface CollectedText {
  text: string;
  stats: SanitizeStats;
}

/**
 * The same answer as `stripInvisibleContent`, without touching the document.
 *
 * One descent that reads and never writes: an element a reader cannot see is
 * skipped along with its subtree, and everything else contributes its text. The
 * hiding rules are `isHidden` and `NEVER_VISIBLE_TAGS` — the same two the
 * mutating version uses, so defence layer 1 has one definition and cannot drift
 * between the path that runs on a live page and the path that runs on fetched
 * HTML.
 *
 * Skipping a whole subtree rather than testing every node also makes this
 * cheaper than what it replaces: a `display:none` menu costs one
 * `getComputedStyle` instead of one per element inside it.
 */
export function collectVisibleText(
  root: Document | Element,
  readStyle = defaultStyleReader(),
): CollectedText {
  const stats: SanitizeStats = { hiddenRemoved: 0, markupRemoved: 0, commentsRemoved: 0 };
  const parts: string[] = [];

  const visit = (node: Node): void => {
    for (const child of node.childNodes) {
      switch (child.nodeType) {
        case 3: // text
          parts.push(child.nodeValue ?? '');
          break;
        case 8: // comment — never reaches a reader, and never reaches textContent either
          stats.commentsRemoved++;
          break;
        case 1: {
          const element = child as Element;
          const tag = element.tagName.toLowerCase();
          if (NEVER_VISIBLE_TAGS.has(tag)) {
            stats.markupRemoved++;
            break;
          }
          if (isHidden(element, readStyle)) {
            stats.hiddenRemoved++;
            break;
          }
          visit(element);
          if (BLOCK_LEVEL_TAGS.has(tag)) parts.push('\n');
          break;
        }
        default:
          break;
      }
    }
  };

  const start = (root as Document).body ?? root;
  visit(start);

  return { text: normaliseWhitespace(parts.join('')), stats };
}

/** Collapses runs of whitespace but keeps paragraph breaks, which help the model. */
export function normaliseWhitespace(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ExtractedText {
  text: string;
  truncated: boolean;
  stats: SanitizeStats;
}

/**
 * Produces the text that will be sent to the model.
 *
 * Truncation is reported rather than hidden: the summary UI says outright when
 * only part of a document was read, because claiming to have summarised a
 * 60,000-word policy that was cut at 24,000 would be the same kind of
 * overclaiming this extension exists to warn people about.
 *
 * Read-only, and it has to stay that way: one of the three places this runs is
 * the page the user is looking at, where removing an element is vandalism.
 * `test/sanitize.test.ts` fails if the source document comes back changed.
 */
export function extractVisibleText(
  root: Document | Element,
  maxChars = 24_000,
  readStyle = defaultStyleReader(),
): ExtractedText {
  const { text, stats } = collectVisibleText(root, readStyle);
  return {
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    stats,
  };
}

/**
 * Wraps untrusted text in a delimiter the system prompt refers to.
 *
 * The closing tag is stripped from the content first: without that, a document
 * containing `</untrusted_document>` could close the block early and have the
 * rest of itself read as instructions.
 */
export function wrapUntrusted(text: string, tag = 'untrusted_document'): string {
  const escaped = text.replaceAll(`</${tag}>`, `<\\/${tag}>`).replaceAll(`<${tag}>`, `<\\${tag}>`);
  return `<${tag}>\n${escaped}\n</${tag}>`;
}

/** Whitespace- and case-insensitive, so a model that re-wraps a line still matches. */
function canonical(text: string): string {
  return text
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Whether a quote really appears in the source document.
 *
 * This is what stops the model from inventing a clause, and — more usefully —
 * what stops it from being talked into reporting a clause that a hidden
 * instruction asked it to report. A point whose quote fails this check is
 * dropped; the rest of the summary survives.
 */
export function isVerbatim(quote: string, source: string): boolean {
  const needle = canonical(quote);
  if (needle.length < 8) return false;
  return canonical(source).includes(needle);
}

/**
 * Picks the element most likely to hold the document's actual prose.
 *
 * A deliberate stand-in for Readability. The extension has to parse HTML in the
 * content script — MV3 service workers have no `DOMParser` — and Readability
 * would put roughly 100 kB into a bundle that loads on every page the user
 * visits. For a policy page, where the whole body is essentially the document,
 * the gain does not justify that: this picks up `<main>`/`<article>` when the
 * site marks them up, and otherwise falls back to the body, which is what
 * Readability would mostly return here anyway.
 */
export function pickMainContent(doc: Document): Element {
  const body = doc.body ?? doc.documentElement;
  const candidates = [...doc.querySelectorAll('main, article, [role="main"], #content, #main, .content')];

  let best: Element | null = null;
  let bestLength = 0;
  for (const candidate of candidates) {
    const length = (candidate.textContent ?? '').length;
    if (length > bestLength) {
      best = candidate;
      bestLength = length;
    }
  }

  // Only trust the candidate if it holds most of the page. A `<main>` wrapping
  // a "skip to content" link should not replace the whole document.
  const bodyLength = (body?.textContent ?? '').length;
  return best && bestLength > bodyLength * 0.4 ? best : body;
}
