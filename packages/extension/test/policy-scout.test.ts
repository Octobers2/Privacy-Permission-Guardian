import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { findPolicyLinks, looksLikePolicyPage, policyCandidates } from '../src/content/policy-scout.ts';

function domOf(body: string): Document {
  return parseHTML(`<!doctype html><html><body>${body}</body></html>`).document as unknown as Document;
}

const PAGE = 'https://shop.example.com/products/42';

describe('findPolicyLinks', () => {
  test('finds a terms link by href', () => {
    const doc = domOf('<a href="/legal/terms-of-service">Legal</a>');
    expect(findPolicyLinks(doc, PAGE)).toEqual(['https://shop.example.com/legal/terms-of-service']);
  });

  test('finds a terms link by its text', () => {
    const doc = domOf('<a href="/p/12">Terms of Use</a>');
    expect(findPolicyLinks(doc, PAGE)).toEqual(['https://shop.example.com/p/12']);
  });

  test('does not offer a privacy policy: the classifier is for terms of service', () => {
    const doc = domOf('<footer><a href="/privacy">Privacy Policy</a><a href="/legal/privacy-policy">Privacy</a></footer>');
    expect(findPolicyLinks(doc, PAGE)).toEqual([]);
  });

  test('prefers footer links over body prose, and an address that says terms over text that does', () => {
    const doc = domOf(`<p><a href="/blog/terms-explained">Terms explained</a></p>
      <footer><a href="/terms">Terms</a></footer>`);
    expect(findPolicyLinks(doc, PAGE)[0]).toBe('https://shop.example.com/terms');
  });

  test('accepts a sibling subdomain', () => {
    const doc = domOf('<a href="https://policies.example.com/terms">Terms</a>');
    expect(findPolicyLinks(doc, PAGE)).toEqual(['https://policies.example.com/terms']);
  });

  test('ignores terms hosted on somebody else entirely', () => {
    // Following an off-site "terms" link would analyse the wrong company's document.
    const doc = domOf('<a href="https://tracker.example.net/terms">Terms</a>');
    expect(findPolicyLinks(doc, PAGE)).toEqual([]);
  });

  test('ignores fragments and javascript links', () => {
    const doc = domOf('<a href="#terms">Terms</a><a href="javascript:showTerms()">Terms</a>');
    expect(findPolicyLinks(doc, PAGE)).toEqual([]);
  });

  test('strips query strings and de-duplicates', () => {
    const doc = domOf(`<a href="/terms?lang=en">Terms</a>
      <footer><a href="/terms?lang=zh">服務條款</a></footer>`);
    expect(findPolicyLinks(doc, PAGE)).toEqual(['https://shop.example.com/terms']);
  });

  test('returns nothing when the page links to no terms', () => {
    expect(findPolicyLinks(domOf('<a href="/cart">Cart</a>'), PAGE)).toEqual([]);
  });
});

describe('policyCandidates', () => {
  test('puts links found on the page ahead of guessed paths', () => {
    const doc = domOf('<footer><a href="/legal/user-agreement">Terms</a></footer>');
    const candidates = policyCandidates(doc, PAGE);
    expect(candidates[0]).toBe('https://shop.example.com/legal/user-agreement');
    expect(candidates).toContain('https://shop.example.com/terms');
  });

  test('still offers the conventional paths when the page links to nothing', () => {
    // Plenty of sites only link their terms from a page the user is not on.
    const candidates = policyCandidates(domOf('<a href="/cart">Cart</a>'), PAGE);
    expect(candidates.slice(0, 3)).toEqual(['https://shop.example.com/terms', 'https://shop.example.com/terms-of-service', 'https://shop.example.com/terms-of-use']);
    expect(candidates.some((url) => /privacy/.test(url))).toBe(false);
  });

  test('does not offer the same url twice', () => {
    const doc = domOf('<footer><a href="/terms">Terms</a></footer>');
    expect(policyCandidates(doc, PAGE).filter((url) => url === 'https://shop.example.com/terms')).toHaveLength(1);
  });
});

describe('looksLikePolicyPage', () => {
  test('recognises a terms page by its path', () => {
    for (const url of ['https://policies.google.com/terms', 'https://github.com/site/terms', 'https://example.com/legal/terms-of-service', 'https://example.com/en/user-agreement']) {
      expect(looksLikePolicyPage(domOf(''), url)).toBe(true);
    }
  });

  test('recognises a Chinese path, which the URL object percent-encodes', () => {
    expect(looksLikePolicyPage(domOf(''), 'https://example.com/服務條款')).toBe(true);
  });

  test('recognises a terms page by its title when the path says nothing', () => {
    const doc = parseHTML('<!doctype html><html><head><title>Terms of Service</title></head><body></body></html>').document as unknown as Document;
    expect(looksLikePolicyPage(doc, 'https://example.com/p/9')).toBe(true);
  });

  test('is not fooled by an ordinary page, or by a privacy policy', () => {
    expect(looksLikePolicyPage(domOf(''), 'https://shop.example.com/products/42')).toBe(false);
    expect(looksLikePolicyPage(domOf(''), 'https://policies.google.com/privacy')).toBe(false);
  });
});
