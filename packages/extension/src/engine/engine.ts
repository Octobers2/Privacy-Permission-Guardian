/**
 * The on-device classifier: loads one model bundle with WebLLM and answers the two prompts (`letters-v1`, `pii-v1`).
 *
 * The model is used as a classifier rather than a text generator: for each prompt we read the logits of the option
 * letters at the first answer position and turn them into probabilities. WebLLM's `top_logprobs` stops at 5 options and we
 * have 9, so the logits come from a `LogitProcessor`, which is handed the raw logits of every step (`LetterTap`).
 *
 * Imported by the setup page (first download, self-test) and the offscreen document (everyday use).
 */
import * as webllm from '@mlc-ai/web-llm';
import { letterPrompt, piiPrompt, probabilities, TOS_CATEGORIES, type ModelEntry } from '@ppg/shared';
import { waitForAdapter, type GpuLike } from './device.ts';

/** Captures the logits of a fixed set of token ids at the step it is called for. */
export class LetterTap implements webllm.LogitProcessor {
  ids: number[] = [];
  last: number[] | null = null;
  processLogits(logits: Float32Array): Float32Array {
    this.last = this.ids.map((id) => logits[id]!);
    return logits;
  }
  processSampledToken(): void {}
  resetState(): void {}
}

export interface LoadProgress {
  /** 0..1 across the whole download and compile. */
  fraction: number;
  text: string;
}

export interface EngineOptions {
  /** Server origin, e.g. `https://ppg.example.org`. Bundles are fetched from `<origin>/models/<bundle>`. */
  serverUrl: string;
  model: ModelEntry;
  onProgress?: (progress: LoadProgress) => void;
}

/** hex sha256 -> the `sha256-<base64>` form WebLLM verifies the kernel against. */
export function toSri(hex: string): string {
  const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
  return `sha256-${btoa(String.fromCharCode(...bytes))}`;
}

export function appConfigFor(serverUrl: string, model: ModelEntry): webllm.AppConfig {
  const base = serverUrl.replace(/\/+$/, '');
  return {
    model_list: [
      {
        model: `${base}/models/${model.bundle}`,
        model_id: model.id,
        model_lib: `${base}/models/${model.lib.path}`,
        // 262144 by default, which does not fit in any consumer GPU's memory; classification needs a few hundred tokens.
        overrides: { context_window_size: model.contextWindow },
        integrity: { model_lib: toSri(model.lib.sha256), onFailure: 'error' },
      } as webllm.ModelRecord,
    ],
    cacheBackend: 'cache', // the Cache API: shared by the setup page and the offscreen document, and the most tested backend
  };
}

export async function isDownloaded(serverUrl: string, model: ModelEntry): Promise<boolean> {
  return webllm.hasModelInCache(model.id, appConfigFor(serverUrl, model)).catch(() => false);
}

export async function deleteDownload(serverUrl: string, model: ModelEntry): Promise<void> {
  await webllm.deleteModelAllInfoInCache(model.id, appConfigFor(serverUrl, model));
}

export interface ClassifiedPassage {
  /** Calibrated probabilities over `TOS_CATEGORIES`. */
  probs: number[];
  category: (typeof TOS_CATEGORIES)[number];
}

export class PpgEngine {
  private constructor(
    private readonly engine: webllm.MLCEngine,
    private readonly tap: LetterTap,
    readonly model: ModelEntry,
  ) {}

  /** Downloads (first time) and loads the model onto the GPU. */
  static async load({ serverUrl, model, onProgress }: EngineOptions): Promise<PpgEngine> {
    // The first adapter request on a cold page can come back empty; WebLLM treats that as fatal, so make sure one exists.
    const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
    if (!(await waitForAdapter(gpu))) throw new Error('No WebGPU adapter is available.');

    const tap = new LetterTap();
    tap.ids = model.letterTokenIds;
    const engine = await webllm.CreateMLCEngine(model.id, {
      appConfig: appConfigFor(serverUrl, model),
      logitProcessorRegistry: new Map([[model.id, tap]]),
      initProgressCallback: (report) => onProgress?.({ fraction: report.progress, text: report.text }),
    });
    return new PpgEngine(engine, tap, model);
  }

  /** One prompt -> the raw logits of the first `n` option letters. */
  private async letters(prompt: string, n: number): Promise<number[]> {
    await this.engine.resetChat();
    await this.engine.completions.create({ prompt, max_tokens: 1, temperature: 0 });
    const logits = this.tap.last;
    if (!logits) throw new Error('The model returned no logits.');
    return logits.slice(0, n);
  }

  /** Question 1: what kind of clause is this passage? */
  async classify(passage: string): Promise<ClassifiedPassage> {
    const probs = probabilities(await this.letters(letterPrompt(passage), TOS_CATEGORIES.length), this.model.tasks.tos.temperature);
    return { probs, category: TOS_CATEGORIES[probs.indexOf(Math.max(...probs))]! };
  }

  /** Question 2: does this page show the person's own private information? Needs a model that was trained for it. */
  async askPersonal(url: string, text: string): Promise<{ personal: boolean; probability: number }> {
    const pii = this.model.tasks.pii;
    if (!pii) throw new Error('This model cannot answer the personal-data question.');
    const [pPersonal] = probabilities(await this.letters(piiPrompt(url, text), 2));
    return { personal: pPersonal! >= pii.threshold, probability: pPersonal! };
  }

  async unload(): Promise<void> {
    await this.engine.unload();
  }
}
