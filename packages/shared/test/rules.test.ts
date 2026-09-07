import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { extractForms } from '../src/extract-form.ts';
import { classifyField, scoreForm, shouldEscalate } from '../src/rules.ts';
import type { FormField, FormObservation } from '../src/schemas.ts';

function field(partial: Partial<FormField>): FormField {
  return {
    type: 'text', name: '', id: '', autocomplete: '', placeholder: '', label: '', required: false,
    ...partial,
  };
}

/** Builds an observation the way the content script would, straight from HTML. */
function observe(html: string, pageUrl: string): FormObservation {
  const doc = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
    .document as unknown as Document;
  const observations = extractForms(doc, pageUrl);
  expect(observations.length).toBeGreaterThan(0);
  return observations[0]!;
}

describe('classifyField', () => {
  test('reads the input type first', () => {
    expect(classifyField(field({ type: 'password', name: 'x' }))).toBe('password');
  });

  test('prefers the specific category over the general one', () => {
    // "card security code" contains "card", but it is a CVV field.
    expect(classifyField(field({ label: 'Card security code' }))).toBe('card_cvv');
    expect(classifyField(field({ autocomplete: 'cc-number' }))).toBe('credit_card');
    expect(classifyField(field({ autocomplete: 'cc-exp' }))).toBe('card_expiry');
  });

  test('recognises identity documents in both languages', () => {
    expect(classifyField(field({ label: '身份證號碼' }))).toBe('national_id');
    expect(classifyField(field({ name: 'passport_no' }))).toBe('national_id');
    expect(classifyField(field({ placeholder: 'Social Security Number' }))).toBe('national_id');
  });

  test('recognises bank details', () => {
    expect(classifyField(field({ label: 'IBAN' }))).toBe('bank_account');
    expect(classifyField(field({ label: '銀行戶口號碼' }))).toBe('bank_account');
    expect(classifyField(field({ name: 'routing_number' }))).toBe('bank_account');
  });

  test('falls back to other for fields it cannot place', () => {
    expect(classifyField(field({ name: 'q', placeholder: 'Search' }))).toBe('other');
    expect(classifyField(field({ name: 'comments', label: 'Anything else?' }))).toBe('other');
  });
});

describe('scoreForm', () => {
  test('a plain newsletter signup scores nothing', () => {
    const result = scoreForm(
      observe('<form><label>Email<input type="email" name="e"></label><button>Subscribe</button></form>',
        'https://blog.example.com/'),
    );
    expect(result.score).toBe(0);
    expect(result.verdict).toBe('safe');
  });

  test('a lookalike domain asking for card details reaches danger on rules alone', () => {
    const result = scoreForm(
      observe(`<form action="https://collect.example.ru/x" method="post">
          <label for="c">Credit card number</label><input id="c" autocomplete="cc-number">
          <label for="v">CVV</label><input id="v">
        </form>`,
        'https://secure-paypa1.xyz/verify'),
    );
    expect(result.verdict).toBe('danger');
    expect(result.hits.map((h) => h.id).sort()).toEqual(
      ['credit_card_fields', 'cross_origin_action', 'lookalike_domain'],
    );
    // 35 + 25 + 20
    expect(result.score).toBe(80);
  });

  test('flags a password field on an unencrypted page', () => {
    const result = scoreForm(
      observe('<form><input name="u"><input type="password" name="p"></form>', 'http://example.com/login'),
    );
    expect(result.hits.map((h) => h.id)).toContain('password_over_http');
  });

  test('does not flag the same form once it is served over https', () => {
    const result = scoreForm(
      observe('<form><input name="u"><input type="password" name="p"></form>', 'https://example.com/login'),
    );
    expect(result.hits.map((h) => h.id)).not.toContain('password_over_http');
  });

  test('flags the identity triplet', () => {
    const result = scoreForm(
      observe(`<form>
          <label>Full name<input autocomplete="name"></label>
          <label>Date of birth<input autocomplete="bday"></label>
          <label>Street address<input autocomplete="street-address"></label>
        </form>`, 'https://forms.example.com/apply'),
    );
    expect(result.hits.map((h) => h.id)).toContain('identity_triplet');
  });

  test("caps a legitimate institution's own form at caution", () => {
    // A real bank account application asks for everything, and would otherwise
    // land in the red on its own website.
    const html = `<form>
        <label>姓名<input autocomplete="name"></label>
        <label>出生日期<input autocomplete="bday"></label>
        <label>地址<input autocomplete="street-address"></label>
        <label>身份證號碼<input name="hkid"></label>
        <label>銀行戶口號碼<input name="acct"></label>
      </form>`;
    const legit = scoreForm(observe(html, 'https://www.hsbc.com.hk/accounts/open/'));
    expect(legit.score).toBeGreaterThanOrEqual(60);
    expect(legit.verdict).toBe('caution');
    expect(legit.hits.map((h) => h.id)).toContain('known_brand_domain');

    // The identical form on a lookalike domain stays red.
    const fake = scoreForm(observe(html, 'https://hsbc-verify.top/open/'));
    expect(fake.verdict).toBe('danger');
  });

  test('an allowlisted domain is silenced entirely', () => {
    const result = scoreForm(
      observe('<form action="https://collect.example.ru/x"><input autocomplete="cc-number"></form>',
        'https://secure-paypa1.xyz/'),
      { allowlist: ['secure-paypa1.xyz'] },
    );
    expect(result).toEqual({ score: 0, hits: [], verdict: 'safe' });
  });

  test('scores are capped at 100', () => {
    const result = scoreForm(
      observe(`<form action="https://collect.example.ru/x">
          <input type="password" name="p">
          <label>身份證<input name="hkid"></label>
          <label>IBAN<input name="iban"></label>
          <label>Credit card number<input autocomplete="cc-number"></label>
          <label>CVV<input name="cvv"></label>
        </form>`, 'http://paypa1-secure.top/verify'),
    );
    expect(result.score).toBe(100);
  });
});

describe('shouldEscalate', () => {
  test('escalates at the threshold, not above it', () => {
    expect(shouldEscalate({ score: 30, hits: [], verdict: 'caution' }, 30)).toBe(true);
    expect(shouldEscalate({ score: 29, hits: [], verdict: 'safe' }, 30)).toBe(false);
  });
});
