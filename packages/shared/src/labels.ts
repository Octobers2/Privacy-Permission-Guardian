/**
 * The nine clause classes of the terms-of-service classifier.
 *
 * The order is the option order of the `letters-v1` prompt (A = index 0 … I = index 8) and the MTEB/LegalBench label
 * ids, so a probability vector indexes straight into this array. It mirrors `ml/labels.json`.
 */
export const TOS_CATEGORIES = [
  'limitation_of_liability',
  'contract_by_using',
  'unilateral_change',
  'arbitration',
  'content_removal',
  'choice_of_law',
  'other',
  'unilateral_termination',
  'jurisdiction',
] as const;
export type TosCategory = (typeof TOS_CATEGORIES)[number];

export const OTHER_INDEX = TOS_CATEGORIES.indexOf('other');

/** Everything except `other`: the clause types reported as potentially unfair. */
export const UNFAIR_CATEGORIES = [
  'limitation_of_liability',
  'contract_by_using',
  'unilateral_change',
  'arbitration',
  'content_removal',
  'choice_of_law',
  'unilateral_termination',
  'jurisdiction',
] as const;
export type UnfairCategory = (typeof UNFAIR_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<TosCategory, string> = {
  limitation_of_liability: 'Limitation of liability',
  contract_by_using: 'Contract by using',
  unilateral_change: 'Unilateral change',
  arbitration: 'Mandatory arbitration',
  content_removal: 'Content removal',
  choice_of_law: 'Choice of law',
  other: 'Other',
  unilateral_termination: 'Unilateral termination',
  jurisdiction: 'Jurisdiction',
};

/** One plain-language line per class, shown next to a flagged passage. */
export const CATEGORY_HINTS: Record<UnfairCategory, string> = {
  limitation_of_liability: 'The provider limits or excludes what it owes you if something goes wrong.',
  contract_by_using: 'Using the service counts as agreeing to the terms, even if you never saw them.',
  unilateral_change: 'The provider can change the terms or the service without your agreement.',
  arbitration: 'Disputes go to private arbitration instead of a court, often without class actions.',
  content_removal: 'The provider can remove or edit what you posted, at its own discretion.',
  choice_of_law: 'Disputes are decided under the law of a place chosen by the provider.',
  unilateral_termination: 'The provider can suspend or close your account at its own discretion.',
  jurisdiction: 'Disputes must be brought in a court chosen by the provider.',
};

export function isUnfair(category: string): category is UnfairCategory {
  return (UNFAIR_CATEGORIES as readonly string[]).includes(category);
}
