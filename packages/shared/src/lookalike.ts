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
