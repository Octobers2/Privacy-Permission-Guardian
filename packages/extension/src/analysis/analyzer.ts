/**
 * One analysis, start to finish, in the offscreen document.
 *
 *   privacy check (rules, no network) -> saved result? -> classify clause by clause -> privacy check (model)
 *     -> share (signed-in contributors) -> summarise (if opted in)
 *
 * Everything outside this file is injected (the engine, the network, the clock, the progress sink), so the whole flow is
 * tested with fakes in `test/analyzer.test.ts`. The order is deliberate:
 *  - the cheap personal-data rules run *before* any request, so a page that shows someone's account is never looked up
 *    on the server, let alone uploaded;
 *  - the model's own personal-data question runs *before* sharing or summarising, because it catches pages the rules cannot;
 *  - a saved result is used only if the policy text is unchanged (same hash).
 */
import {
  assessPage,
  buildSummaryPrompt,
  chatJson,
  finaliseSummary,
  MAX_SUMMARY_PASSAGES,
  normalizeForModel,
  passageHasPii,
  ResultUploadSchema,
  segmentDocument,
  sha256Hex,
  SummaryModelResponseSchema,
  SummarySchema,
  TOS_CATEGORIES,
  OTHER_INDEX,
  type EndpointConfig,
  type ModelEntry,
  type Passage,
  type ResultView,
  type Summary,
  type SummaryRequest,
  type UnfairCategory,
} from '@ppg/shared';
import { countCategories, type AnalysisResult, type AnalysisState, type Sharing, type Stage } from './state.ts';

/** Sentences beyond this are not read: a policy this long is mostly boilerplate and would take many minutes. */
export const MAX_SENTENCES = 1_500;
const REQUEST_TIMEOUT_MS = 20_000;

export interface Job {
  /** Newer jobs for the same tab supersede older ones. */
  id: number;
  tabId: number;
  policyUrl: string;
  domain: string;
  text: string;
  truncated: boolean;
  prefs: {
    serverUrl: string;
    /** Manifest id of the model to use. */
    modelId: string;
    summary: 'off' | 'server' | 'byok';
    byok: { baseUrl: string; apiKey: string; model: string };
    /** Bearer token of the signed-in contributor, if any and unexpired. */
    token: string | null;
  };
}

export interface EngineLike {
  model: Pick<ModelEntry, 'id' | 'version' | 'tasks'>;
  /** `previous`: the sentence before, as context for models that use it. `category` is the engine's flag decision. */
  classify(passage: string, previous?: string | null): Promise<{ probs: number[]; category: string }>;
  askPersonal(url: string, text: string): Promise<{ personal: boolean; probability: number }>;
}

export interface Deps {
  /** Loads (or reuses) the model; `onProgress` receives download/load progress text. */
  loadEngine(onProgress: (text: string, fraction: number) => void): Promise<EngineLike>;
  /** Throws away the current engine and loads a fresh one: after the GPU device was lost, nothing else recovers it. */
  recoverEngine(): Promise<EngineLike>;
  fetch: typeof fetch;
  now(): number;
  emit(state: AnalysisState): void;
  isCurrent(): boolean;
}

class Superseded extends Error {}

/** Errors that mean the engine itself is gone (a lost GPU device, a half-unloaded model), as opposed to a bad input. */
const ENGINE_FAILURE = /device|mapAsync|GPUBuffer|GPUQueue|lost|not loaded|destroyed|unmapped/i;

/** Runs `step` on the engine; if the engine dies, loads a new one and tries once more. */
async function resilient<T>(deps: Deps, state: { engine: EngineLike }, step: (engine: EngineLike) => Promise<T>): Promise<T> {
  try {
    return await step(state.engine);
  } catch (error) {
    if (!(error instanceof Error) || !ENGINE_FAILURE.test(error.message)) throw error;
    console.warn('engine failed, reloading it once:', error.message);
    state.engine = await deps.recoverEngine();
    return step(state.engine);
  }
}

export async function analyse(job: Job, deps: Deps): Promise<AnalysisState> {
  const { domain } = job;
  let where = 'starting';
  const working = (stage: Stage, done = 0, total = 0, flagged: Passage[] = [], detail?: string): void => {
    if (!deps.isCurrent()) throw new Superseded();
    where = `${stage} ${done}/${total}`;
    deps.emit({ status: 'working', domain, stage, done, total, flagged, ...(detail ? { detail } : {}) });
  };
  const server = job.prefs.serverUrl.replace(/\/+$/, '');

  try {
    // 1. Rules only: no model, no network.
    working('privacy-check');
    const rules = assessPage({ url: job.policyUrl, text: job.text });
    const textHash = await sha256Hex(job.text);
    const rulesBlocked = rules.personal;

    // 2. A saved result for exactly this text, unless the page looks personal (then the server is not even asked).
    let cached: ResultView | null = null;
    if (!rulesBlocked) {
      working('checking-cache');
      cached = await lookup(server, job.policyUrl, textHash, deps.fetch);
    }
    if (cached) {
      const personal = null;
      const flagged = cached.passages;
      const result = await finish(job, deps, working, {
        policyUrl: job.policyUrl, domain, textHash, model: cached.model, analyzedAt: cached.createdAt, source: 'community',
        passageCount: cached.passageCount, flagged, truncated: job.truncated, sharing: { status: 'already-public' }, personal,
      });
      return { status: 'ready', domain, result };
    }

    // 3. Classify on this device.
    working('loading-model', 0, 0, [], 'Starting…');
    const held = { engine: await deps.loadEngine((text, fraction) => working('loading-model', Math.round(fraction * 100), 100, [], text)) };
    const sentences = segmentDocument(job.text).slice(0, MAX_SENTENCES);
    if (sentences.length === 0) {
      return { status: 'unavailable', domain, reason: 'The page did not contain any readable sentences.' };
    }
    const flagged: Passage[] = [];
    let lastEmit = 0;
    let previous: string | null = null;
    for (const [i, sentence] of sentences.entries()) {
      if (!deps.isCurrent()) throw new Superseded();
      const normalized = normalizeForModel(sentence);
      const { probs, category } = await resilient(deps, held, (e) => e.classify(normalized, previous));
      previous = normalized;
      if (category !== TOS_CATEGORIES[OTHER_INDEX]) {
        flagged.push({ index: i, text: sentence, category: category as UnfairCategory, probs });
      }
      // Progress is throttled: the popup does not need 1,500 updates, and every one is a message.
      if (deps.now() - lastEmit > 300 || i === sentences.length - 1) {
        lastEmit = deps.now();
        working('classifying', i + 1, sentences.length, flagged);
      }
    }

    // 4. The model's own personal-data question, now that it is loaded.
    let personalReasons: string[] | null = rulesBlocked ? rules.reasons : null;
    const engine = held.engine;
    if (!personalReasons && engine.model.tasks.pii) {
      working('privacy-check', sentences.length, sentences.length, flagged);
      const answer = await resilient(deps, held, (e) => e.askPersonal(job.policyUrl, job.text));
      if (answer.personal) personalReasons = ['the on-device check judged this page to show personal information'];
    }

    const model = { id: held.engine.model.id, version: held.engine.model.version };
    const base = {
      policyUrl: job.policyUrl, domain, textHash, model, analyzedAt: new Date(deps.now()).toISOString(), source: 'this-device' as const,
      passageCount: sentences.length, flagged, truncated: job.truncated || sentences.length >= MAX_SENTENCES,
      personal: personalReasons ? { reasons: personalReasons } : null,
    };

    // 5. Share, if allowed.
    let sharing: Sharing;
    if (personalReasons) sharing = { status: 'blocked', reasons: personalReasons };
    else if (!job.prefs.token) sharing = { status: 'not-signed-in' };
    else {
      working('sharing', sentences.length, sentences.length, flagged);
      sharing = await share(server, job.prefs.token, { ...base, textHash, promptVersion: engine.model.tasks.tos.promptVersion }, deps.fetch);
    }

    const result = await finish(job, deps, working, { ...base, sharing });
    return { status: 'ready', domain, result };
  } catch (error) {
    if (error instanceof Superseded) return { status: 'idle', domain };
    // The stack goes to the console of whichever page runs this (the offscreen document); the popup gets the message.
    console.error('analysis failed', error);
    const detail = error instanceof Error ? `while: ${where}\n${error.stack?.split('\n').slice(0, 8).join('\n') ?? ''}` : undefined;
    return { status: 'error', domain, message: error instanceof Error ? error.message : String(error), ...(detail ? { detail } : {}) };
  }
}

/** Adds the optional summary and assembles the result. */
async function finish(
  job: Job,
  deps: Deps,
  working: (stage: Stage, done?: number, total?: number, flagged?: Passage[]) => void,
  partial: Omit<AnalysisResult, 'categories' | 'summary' | 'summaryError'>,
): Promise<AnalysisResult> {
  let summary: Summary | null = null;
  let summaryError: string | null = null;
  const wanted = job.prefs.summary !== 'off' && partial.flagged.length > 0 && !partial.personal;
  if (wanted) {
    working('summarising', 0, 0, partial.flagged);
    try {
      summary = await summarise(job, partial, deps);
    } catch (error) {
      summaryError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ...partial, categories: countCategories(partial.flagged), summary, summaryError };
}

// ---------------------------------------------------------------- network

async function lookup(server: string, policyUrl: string, hash: string, fetchImpl: typeof fetch): Promise<ResultView | null> {
  try {
    const response = await fetchImpl(`${server}/api/v1/lookup?url=${encodeURIComponent(policyUrl)}&hash=${hash}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) return null; // 404 = nothing saved; anything else = carry on locally
    const body = (await response.json()) as { result: ResultView; sameText: boolean | null };
    return body.sameText ? body.result : null;
  } catch {
    return null; // the server being down must never stop the on-device analysis
  }
}

async function share(
  server: string,
  token: string,
  r: { policyUrl: string; domain: string; textHash: string; model: { id: string; version: string }; promptVersion: string; passageCount: number; flagged: Passage[] },
  fetchImpl: typeof fetch,
): Promise<Sharing> {
  // Passages that look like personal data never leave the device, even if the page as a whole was judged public.
  const safe = r.flagged.filter((p) => !passageHasPii(p.text)).slice(0, 500);
  const upload = ResultUploadSchema.safeParse({
    url: r.policyUrl, domain: r.domain, textHash: r.textHash, model: r.model, promptVersion: r.promptVersion, passageCount: r.passageCount, passages: safe,
  });
  if (!upload.success) return { status: 'failed', message: 'The result was not in a shareable form.' };
  try {
    const response = await fetchImpl(`${server}/api/results`, {
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

async function summarise(job: Job, r: Pick<AnalysisResult, 'policyUrl' | 'domain' | 'textHash' | 'flagged'>, deps: Deps): Promise<Summary> {
  // The most confident clauses first, capped: the summary is for the few that matter.
  const top = [...r.flagged].sort((a, b) => Math.max(...b.probs) - Math.max(...a.probs)).slice(0, MAX_SUMMARY_PASSAGES);
  const request: SummaryRequest = {
    url: r.policyUrl, domain: r.domain, textHash: r.textHash,
    passages: top.sort((a, b) => a.index - b.index).map((p) => ({ category: p.category, text: p.text })),
  };

  if (job.prefs.summary === 'byok') {
    const { baseUrl, apiKey, model } = job.prefs.byok;
    if (!baseUrl || !model) throw new Error('Your own summary endpoint is not set up. Add it in the settings.');
    const config: EndpointConfig = { baseUrl, apiKey, model, temperature: 0, maxTokens: 3_000, timeoutMs: 60_000 };
    const { value } = await chatJson(config, buildSummaryPrompt(request), SummaryModelResponseSchema, { fetchImpl: deps.fetch });
    const summary = finaliseSummary(value, { request, model, generatedAt: new Date(deps.now()).toISOString() });
    if (summary.points.length === 0) throw new Error('The summary could not be checked against the document, so it was discarded.');
    return summary;
  }

  const response = await deps.fetch(`${job.prefs.serverUrl.replace(/\/+$/, '')}/api/summary`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(90_000),
  });
  if (response.status === 429) throw new Error('Too many summary requests right now. Try again in a while.');
  if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { message?: string } | null)?.message ?? `The summary service answered ${response.status}.`);
  return SummarySchema.parse(await response.json());
}
