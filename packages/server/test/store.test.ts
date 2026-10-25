import { describe, expect, test } from 'bun:test';
import { ResultStore } from '../src/store.ts';
import { clock, DAY, passage, RESULT_TTL_MS, upload } from './helpers.ts';

function fresh() {
  const c = clock();
  return { c, store: new ResultStore({ file: ':memory:', now: c.now }) };
}

describe('ResultStore', () => {
  test('stores a result and reads it back by url and by id', () => {
    const { store } = fresh();
    const { id } = store.insert(upload(), 'alice');
    const byUrl = store.lookup('https://example.com/terms')!;
    expect(byUrl.id).toBe(id);
    expect(byUrl.unfairCount).toBe(2);
    expect(byUrl.fairCount).toBe(38);
    expect(byUrl.categories).toEqual({ unilateral_termination: 1, arbitration: 1 });
    expect(byUrl.passages.map((p) => p.index)).toEqual([3, 9]);
    expect(byUrl.current).toBe(true);
    expect(store.get(id)).toEqual(byUrl);
  });

  test('keeps the money clauses with the result and drops them with it', () => {
    const { c, store } = fresh();
    const money = [{ index: 4, kind: 'cancellation_fee' as const, text: 'An early termination fee applies.' }, { index: 11, kind: 'no_refund' as const, text: 'All fees are non-refundable.' }];
    const { id } = store.insert(upload({ money }), 'alice');
    expect(store.get(id)!.money).toEqual(money);
    expect(store.recent(5)[0]).not.toHaveProperty('money');
    c.advance(RESULT_TTL_MS + DAY);
    store.purge();
    expect(store.get(id)).toBeNull();
    expect(store['db'].query('SELECT COUNT(*) AS n FROM money_clauses').get()).toEqual({ n: 0 });
  });

  test('the newest upload wins and older ones stay as history', () => {
    const { c, store } = fresh();
    const first = store.insert(upload({ textHash: '1'.repeat(64) }), 'alice');
    c.advance(DAY);
    const second = store.insert(upload({ textHash: '2'.repeat(64), passages: [passage(5, 'jurisdiction')] }), 'bob');

    expect(store.lookup('https://example.com/terms')!.id).toBe(second.id);
    const versions = store.history('https://example.com/terms');
    expect(versions.map((v) => v.id)).toEqual([second.id, first.id]);
    expect(versions.map((v) => v.current)).toEqual([true, false]);
    expect(store.get(first.id)!.current).toBe(false);
  });

  test('a result disappears from every read 30 days after its own upload', () => {
    const { c, store } = fresh();
    const { id } = store.insert(upload(), 'alice');
    c.advance(RESULT_TTL_MS - 1);
    expect(store.lookup('https://example.com/terms')).not.toBeNull();
    c.advance(1);
    expect(store.lookup('https://example.com/terms')).toBeNull();
    expect(store.get(id)).toBeNull();
    expect(store.site('example.com')).toEqual([]);
    expect(store.recent(10)).toEqual([]);
    expect(store.rankings(10)).toEqual([]);
    expect(store.history('https://example.com/terms')).toEqual([]);
  });

  test('re-analysing a policy keeps it current; the older version expires on its own clock', () => {
    const { c, store } = fresh();
    const old = store.insert(upload({ textHash: '1'.repeat(64) }), 'alice');
    c.advance(20 * DAY);
    const fresh2 = store.insert(upload({ textHash: '1'.repeat(64) }), 'alice');
    c.advance(11 * DAY); // old one is now 31 days old
    expect(store.get(old.id)).toBeNull();
    expect(store.lookup('https://example.com/terms')!.id).toBe(fresh2.id);
    expect(store.history('https://example.com/terms')).toHaveLength(1);
  });

  test('purge removes expired rows and their passages, and keeps live ones', () => {
    const { c, store } = fresh();
    store.insert(upload({ url: 'https://old.example.com/terms', domain: 'example.com' }), 'alice');
    c.advance(RESULT_TTL_MS + DAY);
    store.insert(upload({ url: 'https://new.example.com/terms', domain: 'example.com' }), 'alice');
    store.summarySet('k', '{}');
    expect(store.purge()).toEqual({ results: 1, summaries: 0, reports: 0 });
    expect(store.stats().results).toBe(1);
    c.advance(RESULT_TTL_MS + DAY);
    expect(store.purge()).toEqual({ results: 1, summaries: 1, reports: 0 });
  });

  test('site() returns the current result of each policy under the domain, and only that domain', () => {
    const { c, store } = fresh();
    store.insert(upload({ url: 'https://example.com/terms' }), 'a');
    store.insert(upload({ url: 'https://example.com/privacy' }), 'a');
    c.advance(DAY);
    store.insert(upload({ url: 'https://example.com/terms', passages: [passage(1, 'arbitration')] }), 'a');
    store.insert(upload({ url: 'https://other.org/terms', domain: 'other.org' }), 'a');

    const docs = store.site('Example.COM');
    expect(docs.map((d) => d.url)).toEqual(['https://example.com/privacy', 'https://example.com/terms']);
    expect(docs.find((d) => d.url.endsWith('/terms'))!.unfairCount).toBe(1);
  });

  test('recent() lists one row per url, newest first, without passage text', () => {
    const { c, store } = fresh();
    store.insert(upload({ url: 'https://a.example.com/terms' }), 'x');
    c.advance(DAY);
    store.insert(upload({ url: 'https://b.example.com/terms' }), 'x');
    c.advance(DAY);
    store.insert(upload({ url: 'https://a.example.com/terms' }), 'x');
    const rows = store.recent(10);
    expect(rows.map((r) => r.url)).toEqual(['https://a.example.com/terms', 'https://b.example.com/terms']);
    expect('passages' in rows[0]!).toBe(false);
  });

  test('rankings() sums current documents per domain and can sort by share', () => {
    const { store } = fresh();
    store.insert(upload({ url: 'https://big.com/terms', domain: 'big.com', passageCount: 1000, passages: [passage(1, 'arbitration'), passage(2, 'arbitration'), passage(3, 'jurisdiction')] }), 'x');
    store.insert(upload({ url: 'https://small.com/terms', domain: 'small.com', passageCount: 4, passages: [passage(1, 'arbitration'), passage(2, 'jurisdiction')] }), 'x');
    store.insert(upload({ url: 'https://clean.com/terms', domain: 'clean.com', passages: [] }), 'x');
    expect(store.rankings(10).map((r) => r.domain)).toEqual(['big.com', 'small.com']);
    const byShare = store.rankings(10, 'share');
    expect(byShare.map((r) => r.domain)).toEqual(['small.com', 'big.com']);
    expect(byShare[0]!.share).toBe(0.5);
  });

  test('summaries live for 30 days and are keyed on hash, prompt version and model', () => {
    const { c, store } = fresh();
    const key = ResultStore.summaryKey('h', 'summary-v1', 'm');
    expect(key).not.toBe(ResultStore.summaryKey('h', 'summary-v2', 'm'));
    store.summarySet(key, '{"ok":true}');
    expect(store.summaryGet(key)).toBe('{"ok":true}');
    c.advance(RESULT_TTL_MS);
    expect(store.summaryGet(key)).toBeNull();
  });
});

describe('similar clauses', () => {
  const ARB = 'Any dispute arising out of these terms will be resolved exclusively by binding arbitration and you waive any right to a class action.';
  function seeded() {
    const f = fresh();
    f.store.insert(upload({ url: 'https://one.com/terms', domain: 'one.com', passages: [passage(1, 'arbitration', ARB)] }), 'a');
    f.store.insert(upload({ url: 'https://two.com/terms', domain: 'two.com', passages: [passage(2, 'arbitration', 'Any dispute arising out of these terms shall be resolved by binding arbitration, and you waive any right to bring a class action.')] }), 'a');
    f.store.insert(upload({ url: 'https://three.com/terms', domain: 'three.com', passages: [passage(3, 'jurisdiction', ARB)] }), 'a'); // same words, another clause type
    f.store.insert(upload({ url: 'https://four.com/terms', domain: 'four.com', passages: [passage(4, 'arbitration', 'We will ship your order within five business days of payment.')] }), 'a'); // unrelated
    return f;
  }

  test('finds the same clause type on other sites, counted per site', () => {
    const { store } = seeded();
    const found = store.similar(ARB, 'arbitration', 'elsewhere.com')!;
    expect(found.sites).toBe(2);
    expect(found.examples.map((e) => e.domain).sort()).toEqual(['one.com', 'two.com']);
  });

  test('leaves out the asking site, other clause types and unrelated sentences', () => {
    const { store } = seeded();
    expect(store.similar(ARB, 'arbitration', 'one.com')!.examples.map((e) => e.domain)).toEqual(['two.com']);
    expect(store.similar(ARB, 'jurisdiction', 'x.com')!.examples.map((e) => e.domain)).toEqual(['three.com']);
    expect(store.similar('Photographs may be removed from the gallery at our discretion at any time.', 'arbitration', 'x.com')).toBeNull();
  });

  test('a sentence with too few meaningful words matches nothing', () => {
    expect(seeded().store.similar('You agree.', 'arbitration', 'x.com')).toBeNull();
  });

  test('expired and replaced results are not found', () => {
    const { store, c } = seeded();
    c.advance(RESULT_TTL_MS + DAY);
    expect(store.similar(ARB, 'arbitration', 'x.com')).toBeNull();
    store.purge();
    expect(store['db'].query('SELECT COUNT(*) AS n FROM passages_fts').get()).toEqual({ n: 0 });
  });

  test('similarToResult asks for every flagged clause of a stored result', () => {
    const { store } = seeded();
    const { id } = store.insert(upload({ url: 'https://new.com/terms', domain: 'new.com', passages: [passage(7, 'arbitration', ARB), passage(9, 'jurisdiction', 'Nothing alike here whatsoever for matching purposes.')] }), 'a');
    const items = store.similarToResult(id)!;
    expect(items.map((i) => [i.index, i.sites])).toEqual([[7, 2]]);
  });
});
