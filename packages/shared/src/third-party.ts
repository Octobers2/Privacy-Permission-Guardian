/**
 * Registrable domains that a page sending data to is not, by itself, evidence
 * of anything.
 *
 * `sensitive_post_third_party` asks "did this page ship data somewhere that is
 * not itself?". On the real web the answer is almost always yes: analytics,
 * tag managers, payment iframes, CDNs, error reporters and CAPTCHA endpoints
 * are on every checkout page that has ever existed. Without this list the rule
 * fires on every legitimate commerce site and the extension gets uninstalled,
 * which is the failure mode `docs/evaluation.md` puts above recall.
 *
 * The list is deliberately of *infrastructure*, not of "trustworthy companies".
 * Anything here can still be named by another rule — a form posting card
 * details to a CDN is `cross_origin_action` regardless of what this set says.
 *
 * Worker-side: `rules.ts` is the only importer, and it already has the public
 * suffix list it needs to reduce a hostname to a registrable domain.
 */
export const COMMON_THIRD_PARTIES: ReadonlySet<string> = new Set([
  // analytics and tag management
  'google-analytics.com', 'googletagmanager.com', 'googleoptimize.com', 'doubleclick.net',
  'segment.com', 'segment.io', 'hotjar.com', 'mixpanel.com', 'amplitude.com',
  'clarity.ms', 'matomo.cloud', 'plausible.io', 'fullstory.com', 'newrelic.com',
  'nr-data.net', 'sentry.io', 'bugsnag.com', 'datadoghq.com', 'launchdarkly.com',

  // advertising
  'googlesyndication.com', 'googleadservices.com', 'adsrvr.org', 'criteo.com',
  'taboola.com', 'outbrain.com', 'adnxs.com', 'scorecardresearch.com',

  // Google, Microsoft and Apple infrastructure
  'gstatic.com', 'googleapis.com', 'google.com', 'youtube.com', 'ytimg.com',
  'recaptcha.net', 'hcaptcha.com', 'cloudflareinsights.com', 'msecnd.net',
  'aspnetcdn.com', 'office.net', 'apple.com', 'mzstatic.com',

  // CDNs and asset hosts
  'cloudflare.com', 'cdnjs.cloudflare.com', 'jsdelivr.net', 'unpkg.com',
  'bootstrapcdn.com', 'jquery.com', 'fontawesome.com', 'typekit.net',
  'cloudfront.net', 'akamaihd.net', 'akamaized.net', 'fastly.net', 'fastlylb.net',
  'jwpcdn.com', 'vimeocdn.com', 'imgix.net', 'wp.com', 'gravatar.com',

  // payments and identity, which legitimately receive card and login traffic
  'stripe.com', 'stripe.network', 'paypal.com', 'paypalobjects.com', 'braintreegateway.com',
  'adyen.com', 'checkout.com', 'squareup.com', 'klarna.com', 'auth0.com', 'okta.com',

  // support widgets and messaging
  'intercom.io', 'intercomcdn.com', 'zendesk.com', 'zdassets.com', 'crisp.chat',
  'livechatinc.com', 'hubspot.com', 'hs-scripts.com', 'mailchimp.com', 'list-manage.com',
]);
