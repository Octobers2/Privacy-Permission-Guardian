import { describe, expect, test } from 'bun:test';
import { confusionOf, metricsOf } from './metrics.ts';

const result = (actualPhishing: boolean, predictedPhishing: boolean) => ({ actualPhishing, predictedPhishing });

describe('confusionOf', () => {
  test('counts each quadrant', () => {
    expect(
      confusionOf([
        result(true, true),
        result(true, false),
        result(false, true),
        result(false, false),
        result(false, false),
      ]),
    ).toEqual({ truePositive: 1, falseNegative: 1, falsePositive: 1, trueNegative: 2 });
  });
});

describe('metricsOf', () => {
  test('computes the standard measures', () => {
    const m = metricsOf({ truePositive: 8, falsePositive: 2, trueNegative: 8, falseNegative: 2 });
    expect(m.precision).toBeCloseTo(0.8);
    expect(m.recall).toBeCloseTo(0.8);
    expect(m.f1).toBeCloseTo(0.8);
    expect(m.accuracy).toBeCloseTo(0.8);
    expect(m.falsePositiveRate).toBeCloseTo(0.2);
  });

  test('does not divide by zero when a class is empty', () => {
    const m = metricsOf({ truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 });
    expect(m.precision).toBe(0);
    expect(m.recall).toBe(0);
    expect(m.f1).toBe(0);
  });

  test('a detector that flags everything has perfect recall and a terrible false positive rate', () => {
    // The reason the report leads with the false positive rate: recall alone
    // makes "warn on every page" look like a great detector.
    const m = metricsOf({ truePositive: 10, falsePositive: 10, trueNegative: 0, falseNegative: 0 });
    expect(m.recall).toBe(1);
    expect(m.falsePositiveRate).toBe(1);
  });
});
