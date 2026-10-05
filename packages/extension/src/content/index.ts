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
import { SETTINGS_STORAGE_KEY } from '../messages.ts';
import { removeBanner, showBanner } from './banner.ts';
import { scanDocument, watchDocument } from './form-scanner.ts';
import { collectSignals, signalsFingerprint, startResourceWatch } from './page-signals.ts';
import { extractVisibleText, pickMainContent } from '@ppg/shared/sanitize';
import { hasReportableSignals, type PageSignals } from '@ppg/shared/page-signals';
import { looksLikePolicyPage, policyCandidates } from './policy-scout.ts';

/**
 * A warning about a form can tell the user what not to type into it. One raised
 * by the page alone has no form to point at — that is the whole reason it
 * exists, since a kit collecting credentials from loose `contenteditable` divs
 * leaves nothing for the form extractor to find.
 */
const TITLES = {
  form: {
    danger: '呢個表單好可疑，唔好喺度輸入個人資料',
    caution: '呢個表單要求敏感個人資料，請確認網站可信',
  },
  page: {
    danger: '呢個網站有釣魚網站嘅特徵，唔好喺度輸入任何嘢',
    caution: '呢個網站有啲可疑嘅地方，輸入資料之前請確認佢可信',
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
  if (!response || response.paused || !response.worst) {
    removeBanner();
    return;
  }

  const { verdict, reasons, kind } = response.worst;
  if (verdict === 'safe') {
    removeBanner();
    return;
  }

  showBanner(
    { verdict, title: TITLES[kind][verdict], reasons },
    {
      onDismiss: () => {},
      onNeverOnThisSite: () => {
        void send({ type: 'allowlist-site', hostname: location.hostname });
      },
    },
  );
}

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
  if (area === 'local' && changes[SETTINGS_STORAGE_KEY]) void assess(scanDocument(), collectSignals());
});

// Only the live page knows where its own policy is linked from, so the search
// happens here. Fetching and rendering it happens in the offscreen document,
// which is not bound by this page's CSP and has a real rendering engine.
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message?.type === 'policy-candidates') {
    sendResponse(policyCandidates() satisfies PolicyCandidatesResponse);
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
