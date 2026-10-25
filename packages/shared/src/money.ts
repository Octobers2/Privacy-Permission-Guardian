/**
 * Clauses about money: renewals, cancellation fees, refunds and price changes.
 *
 * Not part of the classifier. The model was trained on the eight unfair-clause classes of the benchmark, which has none for
 * fees, and there is no labelled data to train one on. These are patterns on the sentence instead: cheap, explainable and
 * unit-testable, at the price of missing wordings nobody wrote a pattern for. They run on every sentence of a document, fair
 * ones included, because "we may renew your plan" is not an unfair-clause type but is exactly what a reader wants to see.
 */
import { z } from 'zod';

export const MONEY_KINDS = ['auto_renewal', 'cancellation_fee', 'no_refund', 'price_change'] as const;
export type MoneyKind = (typeof MONEY_KINDS)[number];

export const MONEY_LABELS: Record<MoneyKind, string> = {
  auto_renewal: 'Automatic renewal',
  cancellation_fee: 'Cancellation fee',
  no_refund: 'No refunds',
  price_change: 'Price changes',
};

export const MONEY_HINTS: Record<MoneyKind, string> = {
  auto_renewal: 'The plan renews and is charged again unless you cancel in time.',
  cancellation_fee: 'Ending the plan early can cost you a fee or the rest of the contract.',
  no_refund: 'Money you have paid is not given back.',
  price_change: 'The price or fees can go up after you have signed up.',
};

/** In the order they are tried, so a sentence that is about both a fee and a renewal is reported as the fee. */
const PATTERNS: [MoneyKind, RegExp][] = [
  [
    'cancellation_fee',
    new RegExp(
      [
        String.raw`\b(?:early\s+)?(?:termination|cancell?ation)\s+(?:fee|charge|penalt(?:y|ies))`,
        String.raw`\b(?:fee|charge|penalt(?:y|ies))\s+(?:for|on|upon|if you)\s+(?:early\s+)?(?:cancell?(?:ing|ation)?|terminat(?:ing|ion)|ending)`,
        String.raw`\b(?:pay|owe)\b[^.]{0,80}\b(?:remaining|rest of|balance of)\b[^.]{0,60}\b(?:contract|commitment|term|subscription|plan)\b`,
        String.raw`\bliquidated\s+damages\b`,
        String.raw`\brestocking\s+fee`,
      ].join('|'),
      'i',
    ),
  ],
  [
    'auto_renewal',
    new RegExp(
      [
        String.raw`\bauto-?\s?renew\w*`,
        String.raw`\brenew(?:s|ed)?\s+automatically`,
        String.raw`\bautomatic(?:ally)?\s+renew\w*`,
        String.raw`\bautomatic\s+renewal`,
        String.raw`\b(?:recurring|ongoing)\s+(?:billing|charges?|payments?|fees?)`,
        String.raw`\bcontinue\s+(?:until|unless)\s+you\s+cancel`,
        String.raw`\buntil\s+you\s+cancel`,
      ].join('|'),
      'i',
    ),
  ],
  [
    'no_refund',
    new RegExp(
      [
        String.raw`\bnon[-\s]?refundable`,
        String.raw`\bno\s+refunds?\b`,
        String.raw`\b(?:will|shall|do|does)\s+not\s+(?:provide|issue|give|offer|grant)\s+(?:any\s+)?(?:refunds?|credits?)`,
        String.raw`\bnot\s+(?:be\s+)?refund(?:able|ed)`,
        String.raw`\b(?:all\s+)?(?:sales|fees|payments|purchases|charges)\s+are\s+final`,
        String.raw`\bno\s+(?:partial\s+)?(?:refund|credit)\s+(?:will|shall)\s+be`,
        String.raw`\bnot\s+(?:required|obliged|obligated)\s+to\s+(?:give\s+|issue\s+)?refund`,
        String.raw`\bnot\s+entitle\s+you\s+to\s+(?:a\s+)?refund`,
      ].join('|'),
      'i',
    ),
  ],
  [
    'price_change',
    new RegExp(
      [
        String.raw`\b(?:change|increase|raise|modify|adjust|revise|update)\s+(?:our\s+|the\s+|its\s+|your\s+)?(?:prices?|pricing|fees?|rates?|charges?|subscription\s+(?:price|fee)s?)`,
        String.raw`\b(?:prices?|pricing|fees?|rates?|charges?)\s+(?:may|can|are\s+subject\s+to|will)\s+(?:change|increase|vary|be\s+(?:changed|increased|adjusted))`,
        String.raw`\b(?:price|fee|rate)\s+(?:increases?|changes?|adjustments?)`,
      ].join('|'),
      'i',
    ),
  ],
];

export function moneyKind(sentence: string): MoneyKind | null {
  for (const [kind, pattern] of PATTERNS) if (pattern.test(sentence)) return kind;
  return null;
}

export const MAX_MONEY_CLAUSES = 200;

export const MoneyClauseSchema = z
  .object({
    /** Position of the sentence in the document, as for a classified passage. */
    index: z.number().int().min(0).max(100_000),
    text: z.string().min(1).max(2_000),
    kind: z.enum(MONEY_KINDS),
  })
  .strict();
export type MoneyClause = z.infer<typeof MoneyClauseSchema>;

/** Every sentence that matches, in reading order, capped like an upload. */
export function findMoneyClauses(sentences: readonly string[]): MoneyClause[] {
  const found: MoneyClause[] = [];
  for (const [index, text] of sentences.entries()) {
    const kind = moneyKind(text);
    if (kind) found.push({ index, text: text.slice(0, 2_000), kind });
    if (found.length >= MAX_MONEY_CLAUSES) break;
  }
  return found;
}

/**
 * Fee clauses in a document segmented more loosely than the classifier's, so that "All sales are final." (four words) is not lost.
 *
 * `all` is every sentence down to a couple of words; `classified` is the subset the classifier read, in the same order. A fee
 * sentence takes the position it has in the classified list (a sentence the classifier skipped takes the position of the next one
 * it read), so the document strip and "sentence N of M" mean the same thing for both. Two can therefore share a position.
 */
export function findMoneyClausesAmong(all: readonly string[], classified: readonly string[]): MoneyClause[] {
  const found: MoneyClause[] = [];
  let next = 0; // index into `classified` of the next sentence the classifier read
  for (const text of all) {
    const readByModel = classified[next] === text;
    const index = Math.min(next, Math.max(0, classified.length - 1));
    if (readByModel) next += 1;
    const kind = moneyKind(text);
    if (kind) found.push({ index, text: text.slice(0, 2_000), kind });
    if (found.length >= MAX_MONEY_CLAUSES) break;
  }
  return found;
}
