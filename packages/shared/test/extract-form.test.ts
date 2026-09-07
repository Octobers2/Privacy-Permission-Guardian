import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { extractForms, labelFor, resolveActionOrigin, stripQuery } from '../src/extract-form.ts';

function domOf(html: string): Document {
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document as unknown as Document;
}

describe('stripQuery', () => {
  test('drops the query string and fragment', () => {
    expect(stripQuery('https://example.com/pay?token=abc123#step2')).toBe('https://example.com/pay');
  });

  test('leaves a bare path alone', () => {
    expect(stripQuery('https://example.com/pay')).toBe('https://example.com/pay');
  });

  test('degrades gracefully on an unparseable url', () => {
    expect(stripQuery('not a url?x=1')).toBe('not a url');
  });
});

describe('resolveActionOrigin', () => {
  const page = 'https://shop.example.com/checkout';

  test('is null when the form posts back to the same origin', () => {
    expect(resolveActionOrigin(null, page)).toBeNull();
    expect(resolveActionOrigin('/submit', page)).toBeNull();
    expect(resolveActionOrigin('https://shop.example.com/submit', page)).toBeNull();
  });

  test('reports a cross-origin target', () => {
    expect(resolveActionOrigin('https://collect.example.ru/x', page)).toBe('https://collect.example.ru');
  });

  test('ignores non-http schemes', () => {
    expect(resolveActionOrigin('javascript:void(0)', page)).toBeNull();
    expect(resolveActionOrigin('mailto:a@b.com', page)).toBeNull();
  });
});

describe('labelFor', () => {
  test('prefers aria-label', () => {
    const doc = domOf('<input id="a" aria-label="Card number">');
    expect(labelFor(doc.querySelector('input')!, doc)).toBe('Card number');
  });

  test('follows label[for]', () => {
    const doc = domOf('<label for="hkid">身份證號碼</label><input id="hkid">');
    expect(labelFor(doc.querySelector('input')!, doc)).toBe('身份證號碼');
  });

  test('reads a wrapping label', () => {
    const doc = domOf('<label>Bank account <input name="acct"></label>');
    expect(labelFor(doc.querySelector('input')!, doc)).toBe('Bank account');
  });

  test('falls back to the preceding element', () => {
    const doc = domOf('<div><span>CVV</span><input name="cvv"></div>');
    expect(labelFor(doc.querySelector('input')!, doc)).toBe('CVV');
  });

  test('returns empty string when there is nothing to read', () => {
    const doc = domOf('<input name="x">');
    expect(labelFor(doc.querySelector('input')!, doc)).toBe('');
  });
});

describe('extractForms', () => {
  test('describes fields without ever reading a value', () => {
    const doc = domOf(`
      <form action="https://collect.example.ru/x" method="post">
        <label for="cc">Credit card number</label>
        <input id="cc" name="cardnum" autocomplete="cc-number" value="4111111111111111" required>
        <button>Pay now</button>
      </form>`);
    const [observation] = extractForms(doc, 'https://shop.example.com/checkout?sid=1', 'Checkout');

    expect(observation!.form.fields).toEqual([
      {
        type: 'text',
        name: 'cardnum',
        id: 'cc',
        autocomplete: 'cc-number',
        placeholder: '',
        label: 'Credit card number',
        required: true,
      },
    ]);
    expect(JSON.stringify(observation)).not.toContain('4111111111111111');
    expect(observation!.form.actionOrigin).toBe('https://collect.example.ru');
    expect(observation!.form.submitText).toBe('Pay now');
    expect(observation!.page.url).toBe('https://shop.example.com/checkout');
    expect(observation!.page.isHttps).toBe(true);
  });

  test('ignores buttons when listing data fields', () => {
    const doc = domOf(`
      <form><input name="a"><input type="submit" value="Go"><button>Cancel</button></form>`);
    expect(extractForms(doc, 'https://example.com/')[0]!.form.fields.map((f) => f.name)).toEqual(['a']);
  });

  test('skips forms with no data fields', () => {
    const doc = domOf('<form><button>Log out</button></form>');
    expect(extractForms(doc, 'https://example.com/')).toEqual([]);
  });

  test('picks up credential inputs that sit outside any form', () => {
    // Phishing kits routinely skip <form> entirely and post with JavaScript.
    const doc = domOf(`
      <div class="login">
        <input name="user" placeholder="Username">
        <input name="pass" type="password" placeholder="Password">
        <div role="button">Sign in</div>
      </div>`);
    const observations = extractForms(doc, 'https://secure-login.xyz/');
    expect(observations).toHaveLength(1);
    expect(observations[0]!.form.fields.map((f) => f.type)).toEqual(['text', 'password']);
    expect(observations[0]!.form.submitText).toBe('Sign in');
  });

  test('does not invent a form for one stray search box', () => {
    const doc = domOf('<input name="q" placeholder="Search">');
    expect(extractForms(doc, 'https://example.com/')).toEqual([]);
  });

  test('marks a plain http page as not https', () => {
    const doc = domOf('<form><input type="password" name="p"><input name="u"></form>');
    expect(extractForms(doc, 'http://example.com/login')[0]!.page.isHttps).toBe(false);
  });
});
