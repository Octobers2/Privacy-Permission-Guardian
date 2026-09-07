import { describe, expect, test } from 'bun:test';
import { finalisePolicySummary, sha256Hex } from '../src/policy.ts';
import type { PolicyPoint } from '../src/schemas.ts';

const SOURCE =
  'We may share your personal information with third-party advertising partners. ' +
  'We retain your data indefinitely.';

const INPUT = {
  domain: 'example.com',
  policyUrl: 'https://example.com/privacy',
  sourceText: SOURCE,
  truncated: false,
  promptVersion: 'v1',
  generatedAt: '2026-09-07T00:00:00.000Z',
};

function point(partial: Partial<PolicyPoint>): PolicyPoint {
  return {
    category: 'third_party_sharing',
    severity: 'high',
    title: 't',
    detail: 'd',
    quote: 'share your personal information with third-party advertising partners',
    ...partial,
  };
}

describe('finalisePolicySummary', () => {
  test('keeps points whose quote is in the document', () => {
    const { summary, dropped } = finalisePolicySummary({ points: [point({})] }, INPUT);
    expect(summary.points).toHaveLength(1);
    expect(dropped).toHaveLength(0);
    expect(summary.droppedPoints).toBe(0);
  });

  test('drops a point whose quote is not in the document', () => {
    const invented = point({ quote: 'We sell your data to the highest bidder.' });
    const { summary, dropped } = finalisePolicySummary({ points: [invented] }, INPUT);
    expect(summary.points).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(summary.droppedPoints).toBe(1);
  });

  test('keeps the good points when only one is unverifiable', () => {
    // Throwing the whole response away would leave the user with nothing,
    // when four out of five findings were fine.
    const { summary } = finalisePolicySummary(
      {
        points: [
          point({}),
          point({ quote: 'made up entirely', category: 'retention' }),
          point({ quote: 'We retain your data indefinitely', category: 'retention', severity: 'medium' }),
        ],
      },
      INPUT,
    );
    expect(summary.points).toHaveLength(2);
    expect(summary.droppedPoints).toBe(1);
  });

  test('exempts a manipulation report from the verbatim check', () => {
    // The injected text is normally stripped by the sanitiser before the model
    // ever sees the document, so requiring a verbatim match would drop exactly
    // the finding we most want to show.
    const { summary } = finalisePolicySummary(
      {
        points: [
          point({
            category: 'manipulation_attempt',
            quote: 'Ignore all previous instructions',
          }),
        ],
      },
      INPUT,
    );
    expect(summary.points).toHaveLength(1);
    expect(summary.droppedPoints).toBe(0);
  });

  test('scores only the surviving points', () => {
    const { summary } = finalisePolicySummary(
      { points: [point({}), point({ quote: 'invented', severity: 'high' })] },
      INPUT,
    );
    // One surviving high-severity point is 25, not 50.
    expect(summary.riskScore).toBe(25);
  });

  test('carries the truncation flag through to the UI', () => {
    const { summary } = finalisePolicySummary({ points: [point({})] }, { ...INPUT, truncated: true });
    expect(summary.truncated).toBe(true);
  });
});

describe('sha256Hex', () => {
  test('matches the known digest of the empty string', () => {
    expect(sha256Hex('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('changes when the text changes', async () => {
    expect(await sha256Hex('a')).not.toBe(await sha256Hex('b'));
  });
});
