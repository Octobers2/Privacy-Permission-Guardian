/**
 * Public-suffix-aware hostname helpers.
 *
 * Keeping `tldts` behind this module means the extension bundle reaches it
 * through `@ppg/shared` instead of depending on it directly, and it gives the
 * "what counts as the same site?" question exactly one answer.
 */
import { parse as parseHostname } from 'tldts';

/**
 * The domain a user would call "the site": `hsbc.com.hk` for
 * `www.hsbc.com.hk`, `example.co.uk` for `a.b.example.co.uk`.
 *
 * Falls back to the input for hostnames with no registrable part (localhost,
 * bare IPs) so callers always have something to key on.
 */
export function registrableDomain(hostname: string): string {
  return parseHostname(hostname).domain ?? hostname;
}

/** The public suffix without a leading dot: `com.hk`, `xyz`. */
export function publicSuffixOf(hostname: string): string {
  return parseHostname(hostname).publicSuffix ?? '';
}

/** The registrable label with the suffix removed: `hsbc` for `hsbc.com.hk`. */
export function registrableLabel(hostname: string): string | null {
  return parseHostname(hostname).domainWithoutSuffix ?? null;
}

export function isSameSite(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}
