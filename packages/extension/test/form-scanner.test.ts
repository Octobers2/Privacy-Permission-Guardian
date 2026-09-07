import { describe, expect, test } from 'bun:test';
import type { FormObservation } from '@ppg/shared';
import { fingerprintOf } from '../src/content/form-scanner.ts';

const page = { url: 'https://example.com/pay', hostname: 'example.com', isHttps: true, title: '' };

function observation(names: string[], actionOrigin: string | null = null): FormObservation {
  return {
    page,
    form: {
      fields: names.map((name) => ({
        type: 'text', name, id: '', autocomplete: '', placeholder: '', label: '', required: false,
      })),
      actionOrigin,
      method: 'post',
      submitText: '',
    },
  };
}

describe('fingerprintOf', () => {
  test('is stable across a re-render that rebuilds the same fields', () => {
    expect(fingerprintOf([observation(['user', 'pass'])])).toBe(
      fingerprintOf([observation(['user', 'pass'])]),
    );
  });

  test('ignores the order fields are discovered in', () => {
    expect(fingerprintOf([observation(['user', 'pass'])])).toBe(
      fingerprintOf([observation(['pass', 'user'])]),
    );
  });

  test('changes when a form gains a field', () => {
    // A checkout that reveals its card fields after the first step has to be
    // reassessed, not treated as already seen.
    expect(fingerprintOf([observation(['user', 'pass'])])).not.toBe(
      fingerprintOf([observation(['user', 'pass', 'cardnum'])]),
    );
  });

  test('changes when the form starts posting somewhere else', () => {
    expect(fingerprintOf([observation(['user'])])).not.toBe(
      fingerprintOf([observation(['user'], 'https://collect.example.ru')]),
    );
  });

  test('distinguishes one form from two', () => {
    expect(fingerprintOf([observation(['user'])])).not.toBe(
      fingerprintOf([observation(['user']), observation(['email'])]),
    );
  });
});
