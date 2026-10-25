/**
 * Uploads a finished result to the results server. Runs only after the user said yes (the popup's "Share" button):
 * the analyser stops at `{ status: 'offer' }`.
 */
import { passageHasPii, ResultUploadSchema } from '@ppg/shared';
import type { AnalysisResult, Sharing } from './state.ts';

const REQUEST_TIMEOUT_MS = 20_000;

/** What would be sent, as the popup lists it on the card and as `shareResult` builds it: personal-looking sentences never go. */
export function uploadBody(r: Pick<AnalysisResult, 'policyUrl' | 'domain' | 'textHash' | 'model' | 'passageCount' | 'flagged' | 'money'> & { promptVersion?: string }) {
  return ResultUploadSchema.safeParse({
    url: r.policyUrl, domain: r.domain, textHash: r.textHash, model: r.model, promptVersion: r.promptVersion ?? 'letters-v1', passageCount: r.passageCount,
    passages: r.flagged.filter((p) => !passageHasPii(p.text)).slice(0, 500),
    money: (r.money ?? []).filter((m) => !passageHasPii(m.text)),
  });
}

export async function shareResult(server: string, token: string, r: Parameters<typeof uploadBody>[0], fetchImpl: typeof fetch): Promise<Sharing> {
  const upload = uploadBody(r);
  if (!upload.success) return { status: 'failed', message: 'The result was not in a shareable form.' };
  try {
    const response = await fetchImpl(`${server.replace(/\/+$/, '')}/api/results`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(upload.data), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) return { status: 'failed', message: 'Your sign-in has expired. Sign in again in the settings to share results.' };
    if (response.status === 422) return { status: 'failed', message: 'The server declined to store this result.' };
    if (!response.ok) return { status: 'failed', message: `The server answered ${response.status}.` };
    return { status: 'shared', id: ((await response.json()) as { id: number }).id };
  } catch {
    return { status: 'failed', message: 'Could not reach the server to share the result.' };
  }
}
