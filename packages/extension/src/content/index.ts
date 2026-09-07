/**
 * Content script entry point.
 *
 * Extracts the page's forms, asks the service worker what it thinks, and draws
 * a banner. No framework, no scoring, no network — the heavy parts all live in
 * the worker so that visiting a page costs almost nothing.
 */
import type { AssessResponse, ExtensionMessage } from '../messages.ts';
import { SETTINGS_STORAGE_KEY } from '../messages.ts';
import { removeBanner, showBanner } from './banner.ts';
import { scanDocument, watchDocument } from './form-scanner.ts';

const TITLES = {
  danger: '呢個表單好可疑，唔好喺度輸入個人資料',
  caution: '呢個表單要求敏感個人資料，請確認網站可信',
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

async function assess(observations: ReturnType<typeof scanDocument>): Promise<void> {
  if (observations.length === 0) {
    removeBanner();
    return;
  }

  const response = await send<AssessResponse>({ type: 'assess', observations });
  if (!response || response.paused || !response.worst) {
    removeBanner();
    return;
  }

  const { verdict, reasons } = response.worst;
  if (verdict === 'safe') {
    removeBanner();
    return;
  }

  showBanner(
    { verdict, title: TITLES[verdict], reasons },
    {
      onDismiss: () => {},
      onNeverOnThisSite: () => {
        void send({ type: 'allowlist-site', hostname: location.hostname });
      },
    },
  );
}

watchDocument((observations) => void assess(observations));

// Pausing or allowlisting has to take effect on the page the user is looking
// at, not on the next navigation.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_STORAGE_KEY]) void assess(scanDocument());
});
