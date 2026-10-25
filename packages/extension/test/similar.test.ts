import { describe, expect, test } from 'bun:test';
import { TOS_CATEGORIES, type Passage } from '@ppg/shared';
import { similarForClauses, similarForResult } from '../src/analysis/similar.ts';

const probs = (mass: number) => TOS_CATEGORIES.map((c) => (c === 'arbitration' ? mass : c === 'other' ? 1 - mass : 0));
const clause = (index: number, text: string, mass = 0.9): Passage => ({ index, text, category: 'arbitration', probs: probs(mass) });
const ITEMS = { items: [{ index: 2, sites: 3, examples: [{ domain: 'a.com', url: 'https://a.com/terms', text: 'x' }] }] };

function net(status: number, body: unknown = ITEMS) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
  return { impl, calls };
}

describe('similarForResult', () => {
  test('asks by id and sends nothing else', async () => {
    const n = net(200);
    expect(await similarForResult('https://s/', 7, n.impl)).toEqual(ITEMS.items);
    expect(n.calls).toEqual([{ url: 'https://s/api/v1/results/7/similar', init: expect.anything() }]);
    expect(n.calls[0]!.init?.body).toBeUndefined();
  });
  test('any failure is null, not an exception', async () => {
    expect(await similarForResult('https://s', 7, net(404).impl)).toBeNull();
    expect(await similarForResult('https://s', 7, net(200, { nonsense: true }).impl)).toBeNull();
    expect(await similarForResult('https://s', 7, (async () => { throw new Error('x'); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe('similarForClauses', () => {
  test('sends index, type and text of the flagged sentences, most confident first, and no personal-looking one', async () => {
    const n = net(200);
    await similarForClauses('https://s', [clause(1, 'Disputes go to arbitration.', 0.6), clause(2, 'Write to jane.doe@gmail.com about arbitration.', 0.99), clause(3, 'Binding arbitration applies.', 0.95)], 'mine.com', n.impl);
    expect(JSON.parse(String(n.calls[0]!.init!.body))).toEqual({
      domain: 'mine.com',
      passages: [{ index: 3, category: 'arbitration', text: 'Binding arbitration applies.' }, { index: 1, category: 'arbitration', text: 'Disputes go to arbitration.' }],
    });
  });
  test('caps at 50 and sends nothing when there is nothing to send', async () => {
    const many = net(200);
    await similarForClauses('https://s', Array.from({ length: 80 }, (_, i) => clause(i, `Binding arbitration clause number ${i}.`)), 'mine.com', many.impl);
    expect(JSON.parse(String(many.calls[0]!.init!.body)).passages).toHaveLength(50);
    const none = net(200);
    expect(await similarForClauses('https://s', [], 'mine.com', none.impl)).toEqual([]);
    expect(none.calls).toHaveLength(0);
  });
});
