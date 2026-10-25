/**
 * Content script entry point.
 *
 * Extracts the page's forms, asks the service worker what it thinks, and draws
 * a banner. No framework, no scoring, no network — the heavy parts all live in
 * the worker so that visiting a page costs almost nothing.
 */
import type {
  AssessResponse,
  ExtensionMessage,
  ExtractCurrentPageResponse,
  PolicyCandidatesResponse,
} from '../messages.ts';
import { PREFS_STORAGE_KEY } from '../messages.ts';
import { removeBanner, showBanner, type BannerContent } from './banner.ts';
import { scanDocument, watchDocument } from './form-scanner.ts';
import { collectSignals, signalsFingerprint, startResourceWatch } from './page-signals.ts';
import { extractVisibleText, pickMainContent } from '@ppg/shared/sanitize';
import { publishesNoTerms } from './no-terms.ts';
import { findPolicyLinks, guessedPaths, looksLikePolicyPage } from './policy-scout.ts';
import { hasReportableSignals, type PageSignals } from '@ppg/shared/page-signals';

/**
 * A warning about a form can tell the user what not to type into it. One raised
 * by the page alone has no form to point at — that is the whole reason it
 * exists, since a kit collecting credentials from loose `contenteditable` divs
 * leaves nothing for the form extractor to find.
 */
const TITLES = {
  terms: {
    danger: 'This site asks for your details but publishes no terms or privacy policy.',
    caution: 'This site asks for your details but publishes no terms or privacy policy.',
  },
  form: {
    danger: 'This form looks suspicious. Do not enter personal information here.',
    caution: 'This form asks for sensitive personal information. Make sure you trust this site.',
  },
  page: {
    danger: 'This site has the marks of a phishing site. Do not enter anything here.',
    caution: 'Something about this site looks suspicious. Make sure you trust it before entering any information.',
  },
} as const;

async function send<T>(message: ExtensionMessage): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    // The worker restarts on its own schedule and the extension can be reloaded
    // mid-session; neither is worth an error in somebody else's console.
    return null;
  }
}

/** What "Report this site" will send, said before the button is pressed. */
const REPORT_NOTE = 'Report it and others will be told. This sends only the address of this page (nothing after a “?” or “#”) and the usual places terms are kept.';
const NO_TERMS_REASON = 'No link to terms of service or a privacy policy was found on this page.';

/**
 * What the on-device model found on the page when the user had it read the page for lack of terms, once known: the cheap warning
 * that appears on load is redrawn with it, and it survives the page re-checking itself.
 */
let noTermsFindings: string[] | null = null;
let shownRisk = false;
/** The warning about a form or page that is up, so the model's findings can be added to it instead of being dropped. */
let riskContent: BannerContent | null = null;

const noTermsBanner = (findings: string[] | null, tried: string[]): BannerContent => ({
  verdict: 'caution',
  title: findings === null
    ? TITLES.terms.caution
    : findings.length
      ? 'No terms of service were found, and the page itself holds clauses that may work against you.'
      : 'No terms of service were found for this site.',
  reasons: [
    ...(findings === null
      ? [NO_TERMS_REASON]
      : [
          findings.length ? `The on-device model found: ${findings.slice(0, 5).join(', ')}.` : 'The on-device model found nothing suspicious in the text of this page, but that is not the same as terms.',
          'This page does not link to any terms, and the usual addresses (such as /terms) do not exist.',
        ]),
  ],
  action: reportAction(tried),
});

async function assess(
  observations: ReturnType<typeof scanDocument>,
  signals: PageSignals,
): Promise<void> {
  // Most pages have no form and nothing to report. Asking the worker anyway
  // would put a message on every page the user visits to be told "nothing",
  // which is the cost this extension is built around not paying.
  if (observations.length === 0 && !hasReportableSignals(signals)) {
    removeBanner();
    return;
  }

  const response = await send<AssessResponse>({ type: 'assess', observations, signals });
  if (!response || response.paused) {
    removeBanner();
    return;
  }

  const found = response.worst;
  const worst = found && found.verdict !== 'safe' ? { ...found, verdict: found.verdict } : null;
  // A site that wants a password or a card and publishes nothing about what it does with them is worth saying so, whatever the
  // form rules made of the form. Silenced by "Do not warn me on this site", like the rest. Not on a page already judged dangerous:
  // there "no terms" is the least of it, and reporting it as that would be the wrong report.
  const noTerms = !response.allowed && worst?.verdict !== 'danger' && publishesNoTerms(observations);
  if (!worst && !noTerms) {
    removeBanner();
    return;
  }

  shownRisk = worst !== null;
  const tried = [...guessedPaths(location.href)];
  riskContent = worst
    ? {
        verdict: worst.verdict,
        title: TITLES[worst.kind][worst.verdict],
        reasons: [...worst.reasons, ...(noTerms ? [NO_TERMS_REASON] : [])],
        ...(noTerms ? { action: reportAction(tried) } : {}),
      }
    : null;
  showBanner(riskContent ?? noTermsBanner(noTermsFindings, tried), bannerHandlers);
}

const bannerHandlers = {
  onDismiss: () => {},
  onNeverOnThisSite: () => {
    void send({ type: 'allowlist-site', hostname: location.hostname });
  },
};

/** The Report button: pressing it is the only thing that sends anything. */
const reportAction = (tried: string[]) => ({
  label: 'Report this site',
  note: REPORT_NOTE,
  run: async () => (await send<{ message: string }>({ type: 'report-missing-terms', tried }))?.message ?? 'The report could not be sent.',
});

const watch = watchDocument(
  (observations, signals) => void assess(observations, signals),
  { signalsOf: collectSignals, fingerprintSignals: signalsFingerprint },
);

// A page that posts what you typed does it seconds after load, with the DOM
// untouched. Nothing would mutate, so nothing would re-trigger the watcher.
startResourceWatch(() => watch.refresh());

// Pausing or allowlisting has to take effect on the page the user is looking
// at, not on the next navigation.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PREFS_STORAGE_KEY]) void assess(scanDocument(), collectSignals());
});

// Only the live page knows where its own policy is linked from, so the search
// happens here. Fetching and rendering it happens in the offscreen document,
// which is not bound by this page's CSP and has a real rendering engine.
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  // The worker read this site's terms (or tried to) and found none. A warning already on the page stays: it may be worse than this one.
  if (message?.type === 'show-no-terms') {
    noTermsFindings = message.suspicious;
    // A warning about a form or a phishing page stays the headline, and gets the findings added; otherwise the cheap "no terms"
    // warning is redrawn with them.
    if (shownRisk && riskContent) {
      const found = message.suspicious.length
        ? `No terms of service were found. The on-device model found on this page: ${message.suspicious.slice(0, 5).join(', ')}.`
        : 'No terms of service were found. The on-device model found nothing suspicious in the text of this page.';
      showBanner({ ...riskContent, reasons: [...riskContent.reasons.filter((r) => r !== NO_TERMS_REASON), found], ...(riskContent.verdict === 'danger' ? {} : { action: reportAction(message.tried) }) }, bannerHandlers);
    } else showBanner(noTermsBanner(noTermsFindings, message.tried), bannerHandlers);
    return false;
  }

  if (message?.type === 'policy-candidates') {
    sendResponse({ links: findPolicyLinks(document, location.href), guesses: guessedPaths(location.href) } satisfies PolicyCandidatesResponse);
    return false;
  }

  // Reading the live page is the only way to analyse a policy that is rendered
  // by JavaScript — Meta, Google and most large sites serve a shell and fill it
  // in on the client, and the offscreen reader deliberately runs no scripts.
  // Here the site's own scripts have already run and this is simply the text
  // the user is looking at.
  if (message?.type === 'extract-current-page') {
    const policyUrl = location.origin + location.pathname;
    const isPolicyPage = looksLikePolicyPage();

    // The worker throws the text away unless this is a policy page, so on every
    // other page the cheapest correct answer is to not walk the DOM at all.
    if (!isPolicyPage && !message.force) {
      sendResponse({
        isPolicyPage,
        policyUrl,
        text: '',
        truncated: false,
      } satisfies ExtractCurrentPageResponse);
      return false;
    }

    const { text, truncated } = extractVisibleText(pickMainContent(document));
    sendResponse({ isPolicyPage, policyUrl, text, truncated } satisfies ExtractCurrentPageResponse);
    return false;
  }

  return false;
});
