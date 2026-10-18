import { describe, expect, test } from 'bun:test';
import {
  FormAssessRequestSchema,
  FormAssessmentSchema,
  FormFieldSchema,
} from '../src/schemas.ts';

const field = {
  type: 'text',
  name: 'cardnum',
  id: 'cardnum',
  autocomplete: 'cc-number',
  placeholder: '',
  label: 'Credit card number',
  required: true,
};

describe('form field metadata', () => {
  test('accepts metadata-only fields', () => {
    expect(FormFieldSchema.parse(field)).toEqual(field);
  });

  test('rejects a field carrying the user-entered value', () => {
    // The whole premise of the extension is that values never leave the page.
    // If someone adds `value` to the extraction code, this fails loudly rather
    // than quietly exfiltrating what the user typed.
    expect(() => FormFieldSchema.parse({ ...field, value: '4111111111111111' })).toThrow();
  });
});

describe('form assess request', () => {
  const request = {
    page: { url: 'https://secure-paypa1.xyz/verify', hostname: 'secure-paypa1.xyz', isHttps: true, title: 'Verify' },
    fields: [field],
    actionOrigin: 'https://collect.example.ru',
    ruleScore: 85,
    ruleHits: ['lookalike_domain'],
    textSnippet: 'Verify your account',
  };

  test('accepts a well-formed request', () => {
    expect(FormAssessRequestSchema.parse(request)).toEqual(request);
  });

  test('rejects unknown top-level keys', () => {
    expect(() => FormAssessRequestSchema.parse({ ...request, cookies: 'session=abc' })).toThrow();
  });
});
