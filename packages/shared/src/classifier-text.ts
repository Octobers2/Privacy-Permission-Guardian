/**
 * Turns the text of a web page into the text the classifier was trained on.
 *
 * The training sentences (UnfairToS / LexGLUE) are lowercase and tokenised in the Penn Treebank style:
 * `do n't`, `attorneys ' fees`, `( i )`, `` `` quoted . '' ``, spaced commas and semicolons, URLs left whole. A model
 * that has only seen that form is not guaranteed to read ordinary prose the same way, so every sentence is put into
 * that form before it is classified (and shown to people in its original form).
 *
 * `normalizeForModel` ports NLTK's TreebankWordTokenizer rule for rule, plus one rule the corpus follows: addresses
 * are not taken apart. Round trip on the corpus (detokenise, then normalise): 99.8% identical. The Python reference
 * is `ml/golden_text.py`; `test/classifier-text.test.ts` checks this port against it.
 */

// ---------------------------------------------------------------- Treebank tokeniser (NLTK, ported)

const STARTING_QUOTES: [RegExp, string][] = [
  [/^"/g, '``'],
  [/(``)/g, ' $1 '],
  [/([ (\[{<])("|'{2})/g, '$1 `` '],
];
const PUNCTUATION: [RegExp, string][] = [
  [/([:,])([^\d])/g, ' $1 $2'],
  [/([:,])$/g, ' $1 '],
  [/\.\.\./g, ' ... '],
  [/[;@#$%&]/g, ' $& '],
  [/([^.])(\.)([\])}>"']*)\s*$/g, '$1 $2$3 '],
  [/[?!]/g, ' $& '],
  [/([^'])' /g, "$1 ' "],
];
const PARENS_BRACKETS = /[\][(){}<>]/g;
const DOUBLE_DASHES = /--/g;
const ENDING_QUOTES: [RegExp, string][] = [
  [/''/g, " '' "],
  [/"/g, " '' "],
  [/([^' ])('[sS]|'[mM]|'[dD]|') /g, '$1 $2 '],
  [/([^' ])('ll|'LL|'re|'RE|'ve|'VE|n't|N'T) /g, '$1 $2 '],
];
const CONTRACTIONS2: RegExp[] = [/\b(can)(not)\b/gi, /\b(d)('ye)\b/gi, /\b(gim)(me)\b/gi, /\b(gon)(na)\b/gi, /\b(got)(ta)\b/gi, /\b(lem)(me)\b/gi, /\b(more)('n)\b/gi, /\b(wan)(na)(?=\s)/gi];
const CONTRACTIONS3: RegExp[] = [/ ('t)(is)\b/gi, / ('t)(was)\b/gi];

function treebank(text: string): string[] {
  for (const [re, sub] of STARTING_QUOTES) text = text.replace(re, sub);
  for (const [re, sub] of PUNCTUATION) text = text.replace(re, sub);
  text = text.replace(PARENS_BRACKETS, ' $& ').replace(DOUBLE_DASHES, ' -- ');
  text = ` ${text} `;
  for (const [re, sub] of ENDING_QUOTES) text = text.replace(re, sub);
  for (const re of CONTRACTIONS2) text = text.replace(re, '$1 $2');
  for (const re of CONTRACTIONS3) text = text.replace(re, '$1 $2');
  return text.split(/\s+/).filter(Boolean);
}

/** Web addresses and email addresses stay in one piece in the corpus, so they are set aside while the rest is tokenised. */
const ADDRESS = /(?:https?:\/\/|www\.)[^\s<>"']+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

export function normalizeForModel(sentence: string): string {
  const kept: string[] = [];
  const held = sentence.toLowerCase().replace(ADDRESS, (match) => {
    let address = match;
    let tail = '';
    // Sentence punctuation after an address is not part of it.
    while (address && '.,;:!?)]}\'"'.includes(address.at(-1)!)) {
      tail = address.at(-1) + tail;
      address = address.slice(0, -1);
    }
    kept.push(address);
    return `zzurl${kept.length - 1}zz${tail}`;
  });
  return treebank(held)
    .join(' ')
    .replace(/zzurl(\d+)zz/g, (_, i: string) => kept[Number(i)]!);
}

// ---------------------------------------------------------------- sentence splitting

/** Tokens that end in a full stop without ending a sentence. */
const ABBREVIATIONS = new Set([
  'inc', 'ltd', 'llc', 'llp', 'co', 'corp', 'plc', 'gmbh', 'e.g', 'i.e', 'etc', 'vs', 'v', 'no', 'nos', 'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr',
  'u.s', 'u.k', 'u.s.a', 'a.m', 'p.m', 'sec', 'secs', 'art', 'para', 'approx', 'cf', 'ca', 'fig', 'al', 'ed', 'eds', 'ph.d', 'b.v', 's.a', 'n.v', 'l.l.c', 'est',
]);

export interface SegmentOptions {
  /** Fragments shorter than this are headings, menu items or debris, not clauses. */
  minChars?: number;
  minWords?: number;
  /** Longer sentences are cut at a semicolon or space; the corpus' 99th percentile is 712 characters. */
  maxChars?: number;
}

/** Splits one block of text (a paragraph or list item) into sentences. */
export function splitSentences(block: string): string[] {
  const out: string[] = [];
  let start = 0;
  const boundary = /[.!?]+["')\]”’]*\s+(?=["'(“‘\[]?[A-Z0-9•\-–—])/g;
  for (const m of block.matchAll(boundary)) {
    const end = m.index! + m[0].length;
    const before = block.slice(start, m.index! + 1);
    const word = (before.match(/([A-Za-z.]+)\.$/)?.[1] ?? '').toLowerCase();
    // A full stop followed by a closing quote or bracket ends the sentence whatever the word before it is ("... no.").
    const closed = /[.!?]+["')\]”’]+\s/.test(m[0]);
    // "Inc. The", "e.g. the", "U.S. law" and a lone initial are not sentence ends; neither is the number of a heading ("5. Termination").
    if (!closed && (ABBREVIATIONS.has(word) || /^[a-z]$/.test(word) || /^\d+(\.\d+)*\.$/.test(before.trim()))) continue;
    out.push(block.slice(start, end).trim());
    start = end;
  }
  out.push(block.slice(start).trim());
  return out.filter(Boolean);
}

function capLength(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const cut = Math.max(window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(', '), window.lastIndexOf(' '));
    const at = cut > maxChars / 2 ? cut + 1 : maxChars;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** A document's visible text -> the sentences worth classifying, in reading order, in their original form. */
export function segmentDocument(text: string, { minChars = 25, minWords = 5, maxChars = 1_200 }: SegmentOptions = {}): string[] {
  return text
    .split(/\n+/)
    .flatMap((block) => splitSentences(block.replace(/\s+/g, ' ').trim()))
    .flatMap((s) => capLength(s, maxChars))
    .filter((s) => s.length >= minChars && s.split(' ').length >= minWords);
}
