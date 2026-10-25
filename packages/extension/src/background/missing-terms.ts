/**
 * Sites without terms: telling the results server about one (only when the user presses Report), and asking whether others have.
 * Pure of extension APIs, with `fetch` injected, so it is tested like `shared-lookup.ts`.
 */
const TIMEOUT_MS = 15_000;

/** The address as the server wants it: no query string, fragment or credentials, which is where session tokens live. */
export function cleanAddress(address: string): string | null {
  try {
    const url = new URL(address);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}

export interface ReportOutcome {
  ok: boolean;
  message: string;
  reports?: number;
}

export async function reportMissingTerms(deps: { serverUrl: string; url: string | undefined; tried?: string[]; fetch?: typeof fetch }): Promise<ReportOutcome> {
  const url = deps.url ? cleanAddress(deps.url) : null;
  if (!url) return { ok: false, message: 'This is not a regular website page, so there is nothing to report.' };
  const tried = [...new Set((deps.tried ?? []).map(cleanAddress).filter((t): t is string => t !== null))].slice(0, 20);
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${deps.serverUrl.replace(/\/+$/, '')}/api/v1/reports/missing-terms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, tried }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: 'Could not reach the results server to send the report.' };
  }
  const body = (await response.json().catch(() => null)) as { reports?: number; counted?: boolean } | null;
  if (response.status === 201) return { ok: true, message: 'Thank you. This site has been reported.', ...(body?.reports ? { reports: body.reports } : {}) };
  if (response.status === 200) return { ok: true, message: 'You already reported this site today. Thank you.', ...(body?.reports ? { reports: body.reports } : {}) };
  if (response.status === 409) return { ok: false, message: 'This site already has shared terms, so it was not reported.' };
  if (response.status === 422) return { ok: false, message: 'Only websites on the public internet can be reported.' };
  if (response.status === 429) return { ok: false, message: 'Too many reports right now. Try again later.' };
  return { ok: false, message: `The results server answered ${response.status}.` };
}

/** How many people have reported that `domain` has no terms, or null if nobody has (or the server cannot be asked). */
export async function othersFoundNoTerms(deps: { serverUrl: string; domain: string; fetch?: typeof fetch }): Promise<number | null> {
  try {
    const response = await (deps.fetch ?? fetch)(`${deps.serverUrl.replace(/\/+$/, '')}/api/v1/missing-terms/${encodeURIComponent(deps.domain)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { reports?: number } | null;
    return typeof body?.reports === 'number' && body.reports > 0 ? body.reports : null;
  } catch {
    return null;
  }
}
