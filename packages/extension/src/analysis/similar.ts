/** "Seen on N other sites": asking the results server for clauses like the flagged ones. Failures are silent: it is an extra, never a gate. */
import { passageHasPii, SimilarResponseSchema, type Passage, type SimilarItem } from '@ppg/shared';

const TIMEOUT_MS = 15_000;
const MAX = 50;

const parse = async (response: Response): Promise<SimilarItem[] | null> => {
  if (!response.ok) return null;
  const parsed = SimilarResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.items : null;
};

/** For a result the server already stores: nothing is sent but the id. */
export async function similarForResult(server: string, id: number, fetchImpl: typeof fetch = fetch): Promise<SimilarItem[] | null> {
  try {
    return await parse(await fetchImpl(`${server.replace(/\/+$/, '')}/api/v1/results/${id}/similar`, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
  } catch {
    return null;
  }
}

/** For a result read on this device: sends the flagged sentences (the most confident 50). Called only when the user asks. */
export async function similarForClauses(server: string, flagged: readonly Passage[], domain: string, fetchImpl: typeof fetch = fetch): Promise<SimilarItem[] | null> {
  const passages = flagged
    .filter((p) => !passageHasPii(p.text))
    .sort((a, b) => Math.max(...b.probs) - Math.max(...a.probs))
    .slice(0, MAX)
    .map(({ index, category, text }) => ({ index, category, text }));
  if (passages.length === 0) return [];
  try {
    return await parse(
      await fetchImpl(`${server.replace(/\/+$/, '')}/api/v1/similar`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain, passages }), signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
  } catch {
    return null;
  }
}
