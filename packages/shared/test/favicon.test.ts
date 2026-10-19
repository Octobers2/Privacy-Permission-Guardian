import { describe, expect, test } from 'bun:test';
import {
  dhashFromGray,
  hammingDistance,
  isLowContrastIcon,
  matchFaviconHash,
  HASH_HEIGHT,
  HASH_WIDTH,
} from '../src/favicon.ts';

/** A 9x8 grid whose brightness is a function of the column. */
function columns(valueAt: (x: number) => number): number[] {
  const grid: number[] = [];
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH; x++) grid.push(valueAt(x));
  }
  return grid;
}

describe('dhashFromGray', () => {
  test('is 16 hex characters, one bit per horizontal comparison', () => {
    const hash = dhashFromGray(columns((x) => x * 30));
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test('records whether each pixel is brighter than the one to its right', () => {
    // Brightening to the right: no pixel beats its neighbour, so every bit is 0.
    expect(dhashFromGray(columns((x) => x * 30))).toBe('0000000000000000');
    // Darkening to the right: every pixel beats its neighbour.
    expect(dhashFromGray(columns((x) => 240 - x * 30))).toBe('ffffffffffffffff');
  });

  test('refuses a grid of the wrong size rather than hashing nonsense', () => {
    // A caller that mis-sized its canvas would otherwise poison the table with
    // a hash that means nothing and compares against everything.
    expect(() => dhashFromGray([1, 2, 3])).toThrow();
  });
});

describe('hammingDistance', () => {
  test('counts differing bits', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', '0000000000000003')).toBe(2);
  });

  test('hashes of different lengths are not comparable', () => {
    expect(hammingDistance('00', '0000')).toBe(Infinity);
    expect(hammingDistance('zz', '00')).toBe(Infinity);
  });
});

describe('isLowContrastIcon', () => {
  test('a flat icon carries no identity', () => {
    // Without this gate a blank square sits within a few bits of every other
    // flat icon in the table.
    expect(isLowContrastIcon(columns(() => 255))).toBe(true);
    expect(isLowContrastIcon(columns((x) => 128 + x))).toBe(true);
  });

  test('an icon with real shape passes', () => {
    expect(isLowContrastIcon(columns((x) => x * 30))).toBe(false);
  });
});

describe('matchFaviconHash', () => {
  const table = [
    { domain: 'apple.com', hashes: ['ffffffffffffffff'] },
    { domain: 'paypal.com', hashes: ['0000000000000000'] },
  ];

  test('finds the brand whose icon this is', () => {
    expect(matchFaviconHash('ffffffffffffffff', table)).toEqual({ domain: 'apple.com', distance: 0 });
  });

  test('tolerates the few bits a rescale costs', () => {
    expect(matchFaviconHash('fffffffffffffffe', table)).toEqual({ domain: 'apple.com', distance: 1 });
  });

  test('says nothing when nothing is close', () => {
    expect(matchFaviconHash('0f0f0f0f0f0f0f0f', table)).toBeNull();
  });

  test('says nothing when two brands are equally close', () => {
    // An icon that could be either identifies neither, and guessing between
    // them is how a false accusation gets made.
    const ambiguous = [
      { domain: 'a.example', hashes: ['0000000000000000'] },
      { domain: 'b.example', hashes: ['0000000000000001'] },
    ];
    expect(matchFaviconHash('0000000000000000', ambiguous)).toBeNull();
  });
});
