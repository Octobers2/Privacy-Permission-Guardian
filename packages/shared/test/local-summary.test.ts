import { describe, expect, test } from 'bun:test';
import { TOS_CATEGORIES, type UnfairCategory } from '../src/labels.ts';
import { levelOf, localSummary, MAX_LOCAL_POINTS } from '../src/local-summary.ts';
import type { Passage } from '../src/results.ts';

const passage = (index: number, category: UnfairCategory, mass = 0.9): Passage => {
  const probs = TOS_CATEGORIES.map((c) => (c === category ? mass : c === 'other' ? 1 - mass - 0.02 : 0.02 / 7));
  return { index, text: `Sentence ${index} about ${category}.`, category, probs };
};

describe('localSummary', () => {
  test('nothing found is low risk with no points', () => {
    expect(localSummary([], [])).toEqual({ level: 'low', score: 0, points: [] });
  });

  test('one point per type, serious ones first', () => {
    const s = localSummary([passage(1, 'choice_of_law'), passage(2, 'arbitration'), passage(3, 'arbitration', 0.95), passage(4, 'limitation_of_liability')]);
    expect(s.points.map((p) => p.category)).toEqual(['arbitration', 'limitation_of_liability', 'choice_of_law']);
    expect(s.points[0]).toMatchObject({ severity: 'high', count: 2, quote: 'Sentence 3 about arbitration.' });
  });

  test('fee rules join the classifier findings', () => {
    const s = localSummary([passage(1, 'jurisdiction')], [{ index: 5, text: 'An early termination fee applies.', kind: 'cancellation_fee' }]);
    expect(s.points.map((p) => p.category)).toEqual(['cancellation_fee', 'jurisdiction']);
  });

  test('shows at most five points but scores all of them', () => {
    const all: UnfairCategory[] = ['arbitration', 'unilateral_termination', 'limitation_of_liability', 'unilateral_change', 'content_removal', 'jurisdiction', 'choice_of_law', 'contract_by_using'];
    const s = localSummary(all.map((c, i) => passage(i, c)));
    expect(s.points).toHaveLength(MAX_LOCAL_POINTS);
    expect(s.score).toBe(100); // 106 before the cap
    expect(s.level).toBe('high');
  });

  test('level thresholds', () => {
    expect(levelOf(0)).toBe('low');
    expect(levelOf(19)).toBe('low');
    expect(levelOf(20)).toBe('medium');
    expect(levelOf(49)).toBe('medium');
    expect(levelOf(50)).toBe('high');
  });

  test('is deterministic for the same findings', () => {
    const input = [passage(1, 'arbitration'), passage(2, 'content_removal')];
    expect(localSummary(input)).toEqual(localSummary([...input].reverse()));
  });
});
