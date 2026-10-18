import { describe, expect, test } from 'bun:test';
import { assessPage, cnIdValid, detectPii, hkidValid, ibanValid, luhnValid, passageHasPii, urlSignals } from '../src/pii.ts';

const kinds = (t: string) => detectPii(t).map((f) => f.kind);

describe('checksums', () => {
  test('luhn', () => {
    expect(luhnValid('4539578763621486')).toBe(true);
    expect(luhnValid('4539578763621487')).toBe(false);
    expect(luhnValid('12345')).toBe(false);
  });
  test('hkid', () => {
    expect(hkidValid('A123456(3)')).toBe(true);
    expect(hkidValid('A1234563')).toBe(true);
    expect(hkidValid('A123456(4)')).toBe(false);
    expect(hkidValid('AB987654(3)')).toBe(true);
  });
  test('china resident id', () => {
    expect(cnIdValid('11010519491231002X')).toBe(true);
    expect(cnIdValid('110105194912310021')).toBe(false);
  });
  test('iban', () => {
    expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(ibanValid('GB82 WEST 1234 5698 7654 33')).toBe(false);
  });
});

describe('detectPii', () => {
  test('splits consumer mailboxes from company addresses and ignores placeholders', () => {
    expect(kinds('write to jane.doe@gmail.com')).toEqual(['email']);
    expect(kinds('write to jane@mail.qq.com or jane@yahoo.co.uk')).toEqual(['email']);
    expect(kinds('questions? privacy@acme.com or sar@acme.com or mail.eu@acme.com')).toEqual(['contact_email']);
    expect(kinds('use you@example.com as the sample address')).toEqual([]);
  });
  test('card numbers need a valid checksum', () => {
    expect(kinds('card 4539 5787 6362 1486 expires 12/27')).toContain('payment_card');
    expect(kinds('order 4539 5787 6362 1487')).not.toContain('payment_card');
  });
  test('national ids and iban', () => {
    expect(kinds('HKID A123456(3)')).toContain('national_id');
    expect(kinds('SSN 123-45-6789')).toContain('national_id');
    expect(kinds('SSN 000-12-3456')).not.toContain('national_id');
    expect(kinds('pay to GB82 WEST 1234 5698 7654 32')).toContain('iban');
  });
  test('date of birth needs its label', () => {
    expect(kinds('Date of birth: 14/03/1988')).toContain('dob');
    expect(kinds('Born: March 4, 1985')).toContain('dob');
    expect(kinds('Effective date: 14/03/1988')).not.toContain('dob');
  });
  test('phone numbers need a plus sign or grouping, and are not dates or prices', () => {
    expect(kinds('call +852 2345 6789')).toContain('phone');
    expect(kinds('call (415) 555-0132')).toContain('phone');
    expect(kinds('last updated 2024-05-17')).not.toContain('phone');
    expect(kinds('invoice total 123456789')).not.toContain('phone');
  });
  test('street addresses', () => {
    expect(kinds('Ship to 221 Baker Street, London')).toContain('address');
    expect(kinds('Flat 5B, 12 Nathan Road, Kowloon')).toContain('address');
  });
  test('never returns the values', () => {
    expect(JSON.stringify(detectPii('jane.doe@gmail.com 4539578763621486'))).not.toMatch(/jane|4539/);
  });
});

describe('passageHasPii', () => {
  test('clauses that name a company mailbox, hotline or office are fine', () => {
    expect(passageHasPii('You may contact legal@acme.com to dispute these terms.')).toBe(false);
    expect(passageHasPii('Call +1 415 555 0132 or write to 500 Market Street to opt out of arbitration.')).toBe(false);
  });
  test('a personal mailbox, card, id or date of birth blocks the passage', () => {
    expect(passageHasPii('Ask jane.doe@gmail.com about it.')).toBe(true);
    expect(passageHasPii('Your HKID A123456(3) is on file.')).toBe(true);
    expect(passageHasPii('Card 4539 5787 6362 1486.')).toBe(true);
    expect(passageHasPii('Date of birth: 1988-03-14')).toBe(true);
  });
});

describe('assessPage', () => {
  const tos = `Terms of Service. Contact us at legal@acme.com or +1 415 555 0132. Acme Inc., 500 Market Street, San Francisco.
    We may terminate your account at any time. Disputes are resolved by arbitration.`;

  test('a policy page that prints company contact details is not personal', () => {
    const r = assessPage({ url: 'https://acme.com/terms', text: tos });
    expect(r.personal).toBe(false);
  });
  test('contact details alone never make a page personal, wherever they appear', () => {
    expect(assessPage({ url: 'https://acme.com/company', text: tos }).personal).toBe(false);
  });
  test('contact details plus a signed-in cue do', () => {
    const text = 'Welcome back, Jane Doe. Phone +852 2345 6789. Flat 5B, 12 Nathan Road, Kowloon.';
    expect(assessPage({ url: 'https://acme.com/home', text }).personal).toBe(true);
  });
  test('contact details on a policy page are ignored even with one cue', () => {
    expect(assessPage({ url: 'https://acme.com/privacy', text: 'See my account page. ' + tos }).personal).toBe(false);
  });
  test('an account page with a personal email is personal', () => {
    const text = 'My account. Signed in as Jane Doe (jane.doe@gmail.com). Order #A12345 shipped to 221 Baker Street.';
    const r = assessPage({ url: 'https://shop.example.net/account/orders', text });
    expect(r.personal).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/personal email/);
  });
  test('a strong signal on a policy URL still counts', () => {
    expect(assessPage({ url: 'https://acme.com/privacy', text: 'Your card 4539 5787 6362 1486 is on file.' }).personal).toBe(true);
  });
  test('an account-like URL alone is not enough', () => {
    expect(assessPage({ url: 'https://acme.com/account/login', text: 'Sign in to continue.' }).personal).toBe(false);
  });
  test('plain documentation is clean', () => {
    expect(assessPage({ url: 'https://docs.acme.com/guide', text: 'Install the package, then call init(). Version 2.3.1, released 2024-05-17.' }).personal).toBe(false);
  });
});

describe('urlSignals', () => {
  test('recognises account areas and policy pages', () => {
    expect(urlSignals('https://x.com/settings/profile').account).toBe(true);
    expect(urlSignals('https://x.com/legal/terms-of-service').policy).toBe(true);
    expect(urlSignals('not a url')).toEqual({ account: false, policy: false });
  });
});
