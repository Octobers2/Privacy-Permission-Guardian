/**
 * Runs analyses in the offscreen document, where the model lives.
 *
 * Why here: a service worker is stopped after 30 seconds without events, which would unload the model and cut a
 * minutes-long analysis off mid-way. An offscreen document stays alive. It has no `chrome.storage`, so it reports into the
 * service worker by message, and the worker writes what the popup reads.
 *
 * One model, one request at a time: the engine reads its answer from a single "last logits" slot, so two analyses (two tabs)
 * must never interleave. Jobs wait their turn; a job that has been superseded by the time it is reached ends at once.
 */
import { isUsable, ModelManifestSchema, type ModelEntry } from '@ppg/shared';
import { analyse, type Deps, type EngineLike, type Job } from '../analysis/analyzer.ts';
import type { AnalysisState } from '../analysis/state.ts';
import type { AnalysisStateMessage, SaveResultMessage } from '../messages.ts';
import type { PpgEngine } from '../engine/engine.ts';

/** Free the GPU after this long without work; the next analysis reloads from the browser cache in a few seconds. */
const IDLE_UNLOAD_MS = 10 * 60_000;

let loaded: { key: string; engine: PpgEngine } | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();
const newest = new Map<number, number>(); // tabId -> id of the latest job

const manifests = new Map<string, ModelEntry[]>();

async function modelFor(serverUrl: string, modelId: string): Promise<ModelEntry> {
  let models = manifests.get(serverUrl);
  if (!models) {
    const response = await fetch(`${serverUrl}/models/manifest.json`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`The server answered ${response.status} when asked for its model list.`);
    models = ModelManifestSchema.parse(await response.json()).models.filter(isUsable);
    manifests.set(serverUrl, models);
  }
  const model = models.find((m) => m.id === modelId);
  if (!model) throw new Error('The model you chose is no longer offered by the server. Open the settings and choose another.');
  return model;
}

async function loadEngine(job: Job, onProgress: (text: string, fraction: number) => void): Promise<EngineLike> {
  const serverUrl = job.prefs.serverUrl.replace(/\/+$/, '');
  const modelId = job.prefs.modelId;
  const key = `${serverUrl}|${modelId}`;
  if (loaded?.key !== key) {
    await loaded?.engine.unload().catch(() => {});
    loaded = null;
    const { PpgEngine } = await import('../engine/engine.ts'); // the large WebLLM chunk loads only when an analysis needs it
    const model = await modelFor(serverUrl, modelId);
    loaded = { key, engine: await PpgEngine.load({ serverUrl, model, onProgress: (p) => onProgress(p.text, p.fraction) }) };
  }
  return loaded.engine;
}

async function resetEngine(): Promise<void> {
  const dead = loaded;
  loaded = null;
  await dead?.engine.unload().catch(() => {});
}

function scheduleUnload(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void loaded?.engine.unload().catch(() => {});
    loaded = null;
  }, IDLE_UNLOAD_MS);
}

function report(tabId: number, jobId: number, state: AnalysisState): void {
  const message: AnalysisStateMessage = { type: 'analysis-state', tabId, jobId, state };
  void chrome.runtime.sendMessage(message).catch(() => {}); // the worker may be restarting; the next update lands
}

export function startAnalysis(job: Job): void {
  newest.set(job.tabId, job.id);
  queue = queue
    .then(async () => {
      if (newest.get(job.tabId) !== job.id) return; // superseded while waiting
      const deps: Deps = {
        loadEngine: (onProgress) => loadEngine(job, onProgress),
        recoverEngine: async () => {
          await resetEngine();
          return loadEngine(job, () => {});
        },
        fetch: globalThis.fetch.bind(globalThis),
        now: () => Date.now(),
        emit: (state) => report(job.tabId, job.id, state),
        isCurrent: () => newest.get(job.tabId) === job.id,
      };
      const final = await analyse(job, deps);
      // A failed engine stays failed (a lost GPU device, a half-loaded model): forget it so the next analysis starts clean.
      if (final.status === 'error') await resetEngine();
      if (newest.get(job.tabId) !== job.id) return;
      report(job.tabId, job.id, final);
      if (final.status === 'ready' && final.result.source === 'this-device' && !final.result.noTerms) {
        void chrome.runtime.sendMessage({ type: 'save-result', result: final.result } satisfies SaveResultMessage).catch(() => {});
      }
    })
    .catch((error) => report(job.tabId, job.id, { status: 'error', domain: job.domain, message: error instanceof Error ? error.message : String(error) }))
    .finally(scheduleUnload);
}
