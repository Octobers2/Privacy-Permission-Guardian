import { describe, expect, test } from 'bun:test';
import { legalCueCount, looksLikeLegalText } from '../src/policy-text.ts';

const TRAFFIC =
  'Road and Traffic Conditions & Special Arrangements. Check the latest traffic news, road closures, special traffic arrangements for public events, and the bus and tram services affected. Real-time speed map. Tunnel tolls and parking vacancies. Typhoon and rainstorm arrangements for public transport.'.repeat(2);

const DISCLAIMER =
  'Disclaimer. While every effort is made to ensure accuracy, the Government shall not be liable for any loss arising from use of this website, and gives no warranty. These terms are governed by the laws of Hong Kong and the courts have jurisdiction. You agree not to copy content without permission; copyright remains with the Government.';

describe('looksLikeLegalText', () => {
  test('an ordinary page about traffic is not terms', () => {
    expect(looksLikeLegalText(TRAFFIC)).toBe(false);
    expect(legalCueCount(TRAFFIC)).toBeLessThan(4);
  });
  test('a disclaimer is', () => {
    expect(looksLikeLegalText(DISCLAIMER)).toBe(true);
  });
  test('a short plain terms page is', () => {
    expect(looksLikeLegalText('Terms of use. You agree to these terms. We may suspend your account without notice. We are not liable for damages.')).toBe(true);
  });
  test('empty and unrelated text are not', () => {
    expect(looksLikeLegalText('')).toBe(false);
    expect(looksLikeLegalText('Welcome to our shop. New arrivals every week.')).toBe(false);
  });
});
