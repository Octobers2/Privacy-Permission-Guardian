import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  FormAssessRequestSchema,
  FormAssessmentSchema,
  FormFieldSchema,
  PolicySummaryResponseSchema,
  SettingsSchema,
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

describe('model responses are treated as untrusted', () => {
  test('rejects a category the model invented', () => {
    expect(() =>
      PolicySummaryResponseSchema.parse({
        points: [{ category: 'totally_fine', severity: 'low', title: 't', detail: 'd', quote: 'q' }],
      }),
    ).toThrow();
  });

  test('rejects an empty point list', () => {
    expect(() => PolicySummaryResponseSchema.parse({ points: [] })).toThrow();
  });

  test('rejects a quote long enough to be the whole document', () => {
    expect(() =>
      PolicySummaryResponseSchema.parse({
        points: [{ category: 'retention', severity: 'low', title: 't', detail: 'd', quote: 'x'.repeat(5_000) }],
      }),
    ).toThrow();
  });

  test('rejects an out-of-range confidence', () => {
    const assessment = { verdict: 'danger', confidence: 1.4, reasons: ['r'], advice: 'a', checklist: [] };
    expect(() => FormAssessmentSchema.parse(assessment)).toThrow();
  });
});

test('default settings satisfy their own schema', () => {
  expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
});
