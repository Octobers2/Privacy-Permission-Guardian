/**
 * Policy summaries, cached per domain.
 *
 * The cache is what makes the extension usable at all: without it, every visit
 * to a site would spend tokens re-reading a document that changes a few times a
 * year, and a live demo would stall on the network in front of an audience.
 *
 * The key includes the document hash and the prompt version, so editing a
 * prompt or a site editing its policy both produce a miss rather than a stale
 * answer served with confidence.
 */
import type { PolicySummary } from '@ppg/shared';
import { PROMPT_VERSION } from '@ppg/shared';

const PREFIX = 'summary:';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

interface CacheEntry {
  contentHash: string;
  promptVersion: string;
  storedAt: number;
  summary: PolicySummary;
}

const keyFor = (domain: string) => `${PREFIX}${domain}`;

export async function readSummary(domain: string, contentHash?: string): Promise<PolicySummary | null> {
  const stored = await chrome.storage.local.get(keyFor(domain));
  const entry = stored[keyFor(domain)] as CacheEntry | undefined;
  if (!entry) return null;

  if (entry.promptVersion !== PROMPT_VERSION) return null;
  if (Date.now() - entry.storedAt > MAX_AGE_MS) return null;
  // Called without a hash when the popup opens and has not fetched the document
  // yet: showing the previous answer beats showing nothing while it decides.
  if (contentHash && entry.contentHash !== contentHash) return null;

  return entry.summary;
}

export async function writeSummary(
  domain: string,
  contentHash: string,
  summary: PolicySummary,
): Promise<void> {
  const entry: CacheEntry = {
    contentHash,
    promptVersion: PROMPT_VERSION,
    storedAt: Date.now(),
    summary,
  };
  await chrome.storage.local.set({ [keyFor(domain)]: entry });
}

export async function clearSummaries(): Promise<number> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}
