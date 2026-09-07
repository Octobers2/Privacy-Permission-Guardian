import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { findPolicyLinks, looksLikePolicyPage, policyCandidates } from '../src/content/policy-scout.ts';

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

describe('policyCandidates', () => {
  test('puts links found on the page ahead of guessed paths', () => {
    const doc = domOf('<footer><a href="/legal/privacy">Privacy</a></footer>');
    const candidates = policyCandidates(doc, PAGE);
    expect(candidates[0]).toBe('https://shop.example.com/legal/privacy');
    expect(candidates).toContain('https://shop.example.com/privacy-policy');
  });

  test('still offers the conventional paths when the page links to nothing', () => {
    // Plenty of sites only link their policy from a page the user is not on.
    const candidates = policyCandidates(domOf('<a href="/cart">Cart</a>'), PAGE);
    expect(candidates).toEqual([
      'https://shop.example.com/privacy',
      'https://shop.example.com/privacy-policy',
      'https://shop.example.com/terms',
      'https://shop.example.com/legal/privacy',
      'https://shop.example.com/policies/privacy',
    ]);
  });

  test('does not offer the same url twice', () => {
    const doc = domOf('<footer><a href="/privacy">Privacy</a></footer>');
    const candidates = policyCandidates(doc, PAGE);
    expect(candidates.filter((url) => url === 'https://shop.example.com/privacy')).toHaveLength(1);
  });
});

describe('looksLikePolicyPage', () => {
  test('recognises a policy page by its path', () => {
    for (const url of [
      'https://policies.google.com/privacy',
      'https://privacycenter.instagram.com/policy/',
      'https://example.com/legal/terms-of-service',
      'https://example.com.hk/私隱政策',
    ]) {
      expect(looksLikePolicyPage(domOf(''), url)).toBe(true);
    }
  });

  test('recognises one by its title when the path says nothing', () => {
    const doc = parseHTML('<!doctype html><html><head><title>Privacy Policy</title></head><body></body></html>')
      .document as unknown as Document;
    expect(looksLikePolicyPage(doc, 'https://example.com/p/12345')).toBe(true);
  });

  test('does not mistake an ordinary page for one', () => {
    // Reading the live page is only right when the page *is* the document; on
    // an ordinary page it would summarise whatever the user happened to be on.
    for (const url of ['https://www.instagram.com/', 'https://shop.example.com/checkout']) {
      expect(looksLikePolicyPage(domOf(''), url)).toBe(false);
    }
  });
});

describe('percent-encoded paths', () => {
  test('finds a link whose path is written in Chinese', () => {
    // URL.pathname percent-encodes non-ASCII, so a naive match never fires on
    // exactly the sites this pattern lists Chinese keywords for.
    const doc = domOf('<footer><a href="/私隱政策">按此</a></footer>');
    // The returned URL stays encoded, which is what has to be fetched; only the
    // matching needs the decoded form.
    expect(findPolicyLinks(doc, PAGE)).toEqual([
      'https://shop.example.com/%E7%A7%81%E9%9A%B1%E6%94%BF%E7%AD%96',
    ]);
  });
});
