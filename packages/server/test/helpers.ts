import { OTHER_INDEX, RESULT_TTL_MS, TOS_CATEGORIES, type ResultUpload, type UnfairCategory } from '@ppg/shared';

export const DAY = 24 * 60 * 60 * 1_000;
export { RESULT_TTL_MS };

/** A probability vector that puts `mass` on `category` and the rest on "other". */
export function probs(category: UnfairCategory, mass = 0.9): number[] {
  const v: number[] = TOS_CATEGORIES.map(() => 0);
  v[TOS_CATEGORIES.indexOf(category)] = mass;
  v[OTHER_INDEX] = 1 - mass;
  return v;
}

export function passage(index: number, category: UnfairCategory, text = `Clause ${index}: we may do this at our discretion.`) {
  return { index, text, category, probs: probs(category) };
}

export function upload(overrides: Partial<ResultUpload> = {}): ResultUpload {
  return {
    url: 'https://example.com/terms',
    domain: 'example.com',
    textHash: 'a'.repeat(64),
    model: { id: 'ppg-0.8b', version: '2026-10-14' },
    promptVersion: 'letters-v1',
    passageCount: 40,
    passages: [passage(3, 'unilateral_termination'), passage(9, 'arbitration')],
    money: [],
    ...overrides,
  };
}

/** A clock the test moves by hand. */
export function clock(start = Date.UTC(2026, 9, 14)) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}
