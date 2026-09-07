import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { findPolicyLinks } from '../src/content/policy-scout.ts';

function domOf(body: string): Document {
  return parseHTML(`<!doctype html><html><body>${body}</body></html>`).document as unknown as Document;
}

const PAGE = 'https://shop.example.com/products/42';

describe('findPolicyLinks', () => {
  test('finds a policy link by href', () => {
    const doc = domOf('<a href="/legal/privacy-policy">Legal</a>');
    expect(findPolicyLinks(doc, PAGE)).toEqual(['https://shop.example.com/legal/privacy-policy']);
  });

  test('finds a policy link by its text', () => {
    const doc = domOf('<a href="/p/9">私隱政策</a>');
    expect(findPolicyLinks(doc, PAGE)).toEqual(['https://shop.example.com/p/9']);
  });

  test('prefers footer links over body prose', () => {
    const doc = domOf(`
      <p>Read our <a href="/about/terms-intro">terms</a> explained.</p>
      <footer><a href="/terms">Terms of service</a></footer>`);
    expect(findPolicyLinks(doc, PAGE)[0]).toBe('https://shop.example.com/terms');
  });

  test('prefers the privacy policy over the terms of service', () => {
    // Privacy is the document that answers "what happens to my data?".
    const doc = domOf(`
      <footer><a href="/terms">Terms</a><a href="/privacy">Privacy</a></footer>`);
    expect(findPolicyLinks(doc, PAGE)[0]).toBe('https://shop.example.com/privacy');
  });

  test('accepts a sibling subdomain', () => {
    const doc = domOf('<a href="https://policies.example.com/privacy">Privacy</a>');
    expect(findPolicyLinks(doc, PAGE)).toEqual(['https://policies.example.com/privacy']);
  });

  test('ignores a policy hosted on somebody else entirely', () => {
    // Following an off-site "privacy" link would summarise the wrong company's
    // policy and attribute it to this site.
    const doc = domOf('<a href="https://tracker.example.net/privacy">Privacy</a>');
    expect(findPolicyLinks(doc, PAGE)).toEqual([]);
  });

  test('ignores fragments and javascript links', () => {
    const doc = domOf('<a href="#privacy">Privacy</a><a href="javascript:showPrivacy()">Privacy</a>');
    expect(findPolicyLinks(doc, PAGE)).toEqual([]);
  });

  test('strips query strings and de-duplicates', () => {
    const doc = domOf(`
      <a href="/privacy?lang=en">Privacy</a>
      <footer><a href="/privacy?lang=zh">私隱</a></footer>`);
    expect(findPolicyLinks(doc, PAGE)).toEqual(['https://shop.example.com/privacy']);
  });

  test('returns nothing when the page links to no policy', () => {
    expect(findPolicyLinks(domOf('<a href="/cart">Cart</a>'), PAGE)).toEqual([]);
  });
});
