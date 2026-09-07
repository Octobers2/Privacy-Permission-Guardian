/**
 * Detects hostnames that impersonate a known brand.
 *
 * This is the one signal in the rule engine that catches phishing on its own,
 * without any model involvement — which is exactly why it carries the highest
 * weight and gets the most tests.
 */

/**
 * Levenshtein edit distance, with an early exit.
 *
 * `max` matters here: the engine only cares whether a hostname is *close* to a
 * brand, so comparing one hostname against a few hundred brands should bail out
 * of the hopeless pairs immediately rather than filling a full matrix for each.
 * Returns `max + 1` when the true distance exceeds `max`.
 */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Single row of the matrix; `prev` holds the diagonal value.
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    let rowMin = row[0]!;

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const current = Math.min(
        row[j]! + 1, // deletion
        row[j - 1]! + 1, // insertion
        prev + cost, // substitution
      );
      prev = row[j]!;
      row[j] = current;
      if (current < rowMin) rowMin = current;
    }

    // Every remaining row can only grow, so once the best cell in this row is
    // already past the budget the answer is out of range.
    if (rowMin > max) return max + 1;
  }

  const distance = row[b.length]!;
  return distance > max ? max + 1 : distance;
}

/* ------------------------------------------------------------- punycode */

const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;
const PUNY_SKEW = 38;
const PUNY_DAMP = 700;
const PUNY_INITIAL_BIAS = 72;
const PUNY_INITIAL_N = 128;

function punyAdapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / PUNY_DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1) {
    d = Math.floor(d / (PUNY_BASE - PUNY_TMIN));
    k += PUNY_BASE;
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * d) / (d + PUNY_SKEW));
}

/**
 * Decodes a single punycode label (RFC 3492), e.g. `xn--pypal-4ve` -> `pаypal`.
 *
 * Neither browsers nor Bun expose a decoder, and without one the entire
 * Cyrillic half of the homoglyph table would be unreachable: an internationalised
 * domain reaches us already encoded, so `xn--pypal-4ve.com` would otherwise look
 * nothing like `paypal.com`.
 *
 * Returns the input unchanged if it is not punycode or is malformed — a bad
 * label is the attacker's problem, not a reason to throw inside a content script.
 */
export function decodePunycodeLabel(label: string): string {
  if (!label.toLowerCase().startsWith('xn--')) return label;
  const encoded = label.slice(4);

  const lastDelimiter = encoded.lastIndexOf('-');
  const basic = lastDelimiter > 0 ? encoded.slice(0, lastDelimiter) : '';
  const digits = lastDelimiter > 0 ? encoded.slice(lastDelimiter + 1) : encoded;

  const output = [...basic];
  let n = PUNY_INITIAL_N;
  let i = 0;
  let bias = PUNY_INITIAL_BIAS;

  for (let pos = 0; pos < digits.length; ) {
    const oldi = i;
    let w = 1;

    for (let k = PUNY_BASE; ; k += PUNY_BASE) {
      if (pos >= digits.length) return label;

      const code = digits.charCodeAt(pos++);
      let digit: number;
      if (code >= 0x30 && code <= 0x39) digit = code - 0x30 + 26;
      else if (code >= 0x61 && code <= 0x7a) digit = code - 0x61;
      else if (code >= 0x41 && code <= 0x5a) digit = code - 0x41;
      else return label;

      i += digit * w;
      const t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
      if (digit < t) break;
      w *= PUNY_BASE - t;
    }

    bias = punyAdapt(i - oldi, output.length + 1, oldi === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff) return label;
    output.splice(i, 0, String.fromCodePoint(n));
    i++;
  }

  return output.join('');
}

/** Decodes every punycode label in a hostname. */
export function decodePunycodeHostname(hostname: string): string {
  return hostname.split('.').map(decodePunycodeLabel).join('.');
}

/* ---------------------------------------------------------- homoglyphs */

/**
 * Characters that render close enough to an ASCII letter to fool a reader.
 *
 * Restricted to the scripts that actually show up in homograph attacks
 * (Cyrillic, Greek, a few Latin extensions) rather than the full Unicode
 * confusables table — a bigger table means more legitimate domains collapsing
 * onto a brand, and a false "this is phishing" banner is expensive.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', з: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p',
  с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l',
  ԛ: 'q', ԝ: 'w', ғ: 'f', ь: 'b', ч: 'y',
  // Greek
  ο: 'o', α: 'a', ν: 'v', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ε: 'e', ι: 'i',
  κ: 'k', μ: 'm', β: 'b', γ: 'y', η: 'n',
  // Latin extensions and other single-script lookalikes
  ı: 'i', ł: 'l', đ: 'd', ø: 'o', ɡ: 'g', ɑ: 'a', ѐ: 'e', օ: 'o', ա: 'w',
};

/** Digits typed in place of the letter they resemble. */
const DIGIT_SUBSTITUTIONS: Record<string, string> = {
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
};

/** Letter pairs that read as a single letter at a glance. */
const LIGATURES: [RegExp, string][] = [
  [/rn/g, 'm'],
  [/vv/g, 'w'],
  [/cl/g, 'd'],
];

/**
 * Folds a hostname label onto a canonical form so that visually similar labels
 * compare equal.
 *
 * `paypa1`, `pаypal` (Cyrillic а) and `payPal` all fold to `paypal`. The result
 * is only ever used for comparison against the brand list — it is never shown
 * to the user, because the folded form is not a real domain.
 */
export function normaliseHomoglyphs(label: string): string {
  // NFKD splits accents off their base letter and folds full-width forms;
  // dropping the combining marks then turns "pа́ypal" into "paypal".
  let out = label
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase();

  out = [...out].map((ch) => CONFUSABLES[ch] ?? ch).join('');
  for (const [pattern, replacement] of LIGATURES) out = out.replace(pattern, replacement);
  out = [...out].map((ch) => DIGIT_SUBSTITUTIONS[ch] ?? ch).join('');

  return out;
}
