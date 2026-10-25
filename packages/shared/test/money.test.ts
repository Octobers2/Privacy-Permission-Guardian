import { describe, expect, test } from 'bun:test';
import { findMoneyClauses, findMoneyClausesAmong, moneyKind, MoneyClauseSchema } from '../src/money.ts';

const CASES: [string, ReturnType<typeof moneyKind>][] = [
  // auto_renewal
  ['Your subscription will automatically renew at the end of each billing period.', 'auto_renewal'],
  ['Plans auto-renew for the same term unless cancelled.', 'auto_renewal'],
  ['The subscription renews automatically every month.', 'auto_renewal'],
  ['You will be charged on a recurring basis until you cancel.', 'auto_renewal'],
  // cancellation_fee
  ['If you cancel in the first year, an early termination fee of 50% of the remaining plan applies.', 'cancellation_fee'],
  ['A cancellation fee may apply.', 'cancellation_fee'],
  ['You must pay the remaining balance of your annual contract if you leave early.', 'cancellation_fee'],
  ['There is a fee for cancelling during the commitment period.', 'cancellation_fee'],
  // no_refund
  ['All fees are non-refundable.', 'no_refund'],
  ['We are not required to refund any payment.', 'no_refund'],
  ['Closing it does not entitle you to a refund.', 'no_refund'],
  ['Return any device within seven days, subject to our restocking fee.', 'cancellation_fee'],
  ['We do not provide refunds for partial months.', 'no_refund'],
  ['All sales are final.', 'no_refund'],
  ['No refunds will be given once the trial ends.', 'no_refund'],
  // price_change
  ['We may change our prices at any time.', 'price_change'],
  ['Subscription fees are subject to change without notice.', 'price_change'],
  ['Prices may increase when your plan renews.', 'price_change'],
  // not about money
  ['You may cancel your account at any time from the settings page.', null],
  ['The price is shown at checkout.', null],
  ['We will send you an email when your order ships.', null],
  ['You agree to resolve disputes through binding arbitration.', null],
  ['Content you post remains yours.', null],
  ['Please update your profile photo.', null],
];

describe('moneyKind', () => {
  for (const [sentence, kind] of CASES) {
    test(`${kind ?? 'none'}: ${sentence}`, () => expect(moneyKind(sentence)).toBe(kind));
  }

  test('a sentence about both a fee and a renewal is reported as the fee', () => {
    expect(moneyKind('The plan renews automatically, and an early termination fee applies if you cancel.')).toBe('cancellation_fee');
  });
});

describe('findMoneyClauses', () => {
  test('keeps the position of each matching sentence', () => {
    const found = findMoneyClauses(['Welcome to the service.', 'All fees are non-refundable.', 'Be kind.', 'We may change our prices at any time.']);
    expect(found.map((m) => [m.index, m.kind])).toEqual([[1, 'no_refund'], [3, 'price_change']]);
    for (const m of found) expect(MoneyClauseSchema.safeParse(m).success).toBe(true);
  });

  test('is empty for a document with nothing about money', () => {
    expect(findMoneyClauses(['Hello.', 'These terms are governed by the laws of Delaware.'])).toEqual([]);
  });
});

describe('findMoneyClausesAmong', () => {
  const all = ['Welcome to the service, please read on.', 'All sales are final.', 'We may change our prices at any time without notice.', 'No refunds.', 'Thanks for reading these terms.'];
  const classified = all.filter((s) => s.split(' ').length >= 5);

  test('finds the short ones the classifier skipped, at the position of the next classified sentence', () => {
    const found = findMoneyClausesAmong(all, classified);
    expect(found.map((m) => [m.index, m.kind, m.text])).toEqual([
      [1, 'no_refund', 'All sales are final.'], // skipped by the classifier: takes the position of the sentence that follows it
      [1, 'price_change', 'We may change our prices at any time without notice.'],
      [2, 'no_refund', 'No refunds.'],
    ]);
  });

  test('a sentence the classifier read keeps its own position', () => {
    expect(findMoneyClausesAmong(['One. Two three four five six.', 'All fees are non-refundable once paid.'], ['All fees are non-refundable once paid.'])[0]!.index).toBe(0);
  });

  test('nothing classified: positions stay in range', () => {
    expect(findMoneyClausesAmong(['No refunds.'], [])[0]!.index).toBe(0);
  });
});
