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
const NEVER_VISIBLE = 'script, style, noscript, template, iframe, object, embed, svg, head';

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
 * Call this on a document parsed from fetched HTML — never on the live page the
 * user is looking at.
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
 */
export function extractVisibleText(
  root: Document | Element,
  maxChars = 24_000,
  readStyle = defaultStyleReader(),
): ExtractedText {
  const stats = stripInvisibleContent(root, readStyle);
  const body = (root as Document).body ?? (root as Element);
  const text = normaliseWhitespace(body?.textContent ?? '');
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
