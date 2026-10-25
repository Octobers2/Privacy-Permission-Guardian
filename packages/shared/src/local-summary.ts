/**
 * "In short": a few plain-English points about a document, built on the device from what the classifier and the fee rules found.
 *
 * No second model writes this. Each type of clause has one fixed explanation and one fixed severity, and the quote under it is the
 * document's own sentence. The wording is therefore always accurate about what the *type* means and says nothing about the details
 * of the clause, which is what the quote is for. The overall level is arithmetic (`riskScore`), as for the optional server summary.
 */
import { CATEGORY_LABELS, type UnfairCategory } from './labels.ts';
import { MONEY_LABELS, type MoneyClause, type MoneyKind } from './money.ts';
import type { Passage } from './results.ts';
import { riskScore } from './score.ts';
import type { Severity } from './schemas.ts';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface LocalPoint {
  category: UnfairCategory | MoneyKind;
  severity: Severity;
  title: string;
  detail: string;
  /** The sentence that triggered it, as written in the document. */
  quote: string;
  /** How many sentences of this type the document has. */
  count: number;
}

export interface LocalSummary {
  level: RiskLevel;
  /** 0 to 100; see `riskScore`. */
  score: number;
  points: LocalPoint[];
}

type Entry = { severity: Severity; title: string; detail: string };

const WORDING: Record<UnfairCategory | MoneyKind, Entry> = {
  arbitration: { severity: 'high', title: 'You may not be able to sue or join a class action', detail: 'Disputes go to a private arbitrator instead of a court.' },
  unilateral_termination: { severity: 'high', title: 'They can close your account without warning', detail: 'Your account can be suspended or ended at their discretion.' },
  cancellation_fee: { severity: 'high', title: 'Leaving early can cost you a fee', detail: 'Ending the plan before its term is up can bring a charge.' },
  limitation_of_liability: { severity: 'medium', title: 'They answer for very little if things go wrong', detail: 'The provider limits or excludes what it owes you for losses.' },
  unilateral_change: { severity: 'medium', title: 'The terms can change under you', detail: 'The provider can change the terms or the service without your agreement.' },
  content_removal: { severity: 'medium', title: 'They can remove what you post', detail: 'Your content can be removed or edited at the provider’s discretion.' },
  jurisdiction: { severity: 'medium', title: 'Disputes must go to a court of their choosing', detail: 'You may have to bring a claim in a place far from where you live.' },
  auto_renewal: { severity: 'medium', title: 'The plan renews and is charged again by itself', detail: 'Unless you cancel in time, you are billed again for another period.' },
  no_refund: { severity: 'medium', title: 'Money you pay may not come back', detail: 'Payments are described as final or non-refundable.' },
  price_change: { severity: 'medium', title: 'The price can go up after you sign up', detail: 'The provider can change prices or fees.' },
  choice_of_law: { severity: 'low', title: 'Their choice of law applies to disputes', detail: 'Disputes are decided under the law of a place the provider chose.' },
  contract_by_using: { severity: 'low', title: 'Using the service counts as agreeing', detail: 'You are bound by the terms just by using the service.' },
};

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
/** The fee rules have no probability; their sentences are shown as if the model were quite sure. */
const RULE_CONFIDENCE = 0.9;
export const MAX_LOCAL_POINTS = 5;

export const levelOf = (score: number): RiskLevel => (score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low');
export const LEVEL_LABELS: Record<RiskLevel, string> = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };

export function localSummary(flagged: readonly Passage[], money: readonly MoneyClause[] = []): LocalSummary {
  const groups = new Map<UnfairCategory | MoneyKind, { quote: string; confidence: number; count: number }>();
  const add = (category: UnfairCategory | MoneyKind, quote: string, confidence: number) => {
    const group = groups.get(category);
    if (!group) groups.set(category, { quote, confidence, count: 1 });
    else {
      group.count += 1;
      if (confidence > group.confidence) Object.assign(group, { quote, confidence });
    }
  };
  for (const p of flagged) add(p.category, p.text, Math.max(...p.probs));
  for (const m of money) add(m.kind, m.text, RULE_CONFIDENCE);

  const all = [...groups.entries()].map(([category, g]) => ({ category, ...g, ...WORDING[category] }));
  const score = riskScore(all);
  const points = all
    .sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.confidence - a.confidence)
    .slice(0, MAX_LOCAL_POINTS)
    .map(({ category, severity, title, detail, quote, count }): LocalPoint => ({ category, severity, title, detail, quote, count }));
  return { level: levelOf(score), score, points };
}

/** The name of a point's type, for a label next to its title. */
export const pointLabel = (category: UnfairCategory | MoneyKind): string =>
  category in MONEY_LABELS ? MONEY_LABELS[category as MoneyKind] : CATEGORY_LABELS[category as UnfairCategory];
