import { describe, expect, test } from 'bun:test';
import { OTHER_INDEX, TOS_CATEGORIES, type Passage } from '@ppg/shared';
import { shareResult, uploadBody } from '../src/analysis/share.ts';

const probs = TOS_CATEGORIES.map((c) => (c === 'arbitration' ? 0.9 : c === 'other' ? 0.1 : 0));
const flagged = (index: number, text: string): Passage => ({ index, text, category: 'arbitration', probs });
const result = (over = {}) => ({
  policyUrl: 'https://example.com/terms', domain: 'example.com', textHash: 'a'.repeat(64), model: { id: 'ppg-fast', version: '1' }, passageCount: 40,
  flagged: [flagged(3, 'Any dispute goes to binding arbitration.')], money: [{ index: 8, kind: 'no_refund' as const, text: 'All fees are non-refundable.' }], ...over,
});

function network(status: number, body: unknown = { id: 7 }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
  return { impl, calls };
}

describe('shareResult', () => {
  test('sends the flagged clauses and the money clauses with the contributor token, and nothing else of the page', async () => {
    const net = network(201);
    expect(await shareResult('https://ppg.example.org/', 'tok', result(), net.impl)).toEqual({ status: 'shared', id: 7 });
    expect(net.calls[0]!.url).toBe('https://ppg.example.org/api/results');
    expect((net.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const body = JSON.parse(String(net.calls[0]!.init.body));
    expect(body.passages.map((p: Passage) => p.index)).toEqual([3]);
    expect(body.money).toEqual(result().money);
    expect(body.passageCount).toBe(40);
  });

  test('a clause that looks personal never goes, in either list', () => {
    const upload = uploadBody(result({
      flagged: [flagged(1, 'Disputes go to arbitration.'), flagged(2, 'Write to jane.doe@gmail.com about arbitration.')],
      money: [{ index: 4, kind: 'no_refund' as const, text: 'Refunds go to jane.doe@gmail.com.' }],
    }));
    expect(upload.success && upload.data.passages.map((p) => p.index)).toEqual([1]);
    expect(upload.success && upload.data.money).toEqual([]);
  });

  test('an expired sign-in is explained', async () => {
    expect(await shareResult('https://s', 't', result(), network(401, {}).impl)).toMatchObject({ status: 'failed', message: expect.stringContaining('sign-in has expired') });
  });

  test('an unreachable server is a failure, not an exception', async () => {
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await shareResult('https://s', 't', result(), down)).toMatchObject({ status: 'failed' });
  });

  test('a result saved before fee rules existed still uploads', () => {
    const { money: _m, ...old } = result();
    expect(uploadBody(old as never).success).toBe(true);
  });
});

test('OTHER_INDEX is the "other" class', () => expect(TOS_CATEGORIES[OTHER_INDEX]).toBe('other'));
