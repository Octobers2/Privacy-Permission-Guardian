/**
 * Can this machine run the on-device model, and which one should it start with?
 *
 * The check asks the browser for a real WebGPU adapter rather than guessing from the user agent. Two things make that
 * less obvious than it sounds, both found while building the spike (`spike/webllm/FINDINGS.md`):
 *  - the first `requestAdapter()` on a cold page can return null while the GPU process starts, and a second call works;
 *  - the discrete GPU is only returned when `high-performance` is requested, otherwise Chromium may fall back to a
 *    software adapter that cannot run the model at all.
 */
import type { ModelEntry } from '@ppg/shared';

/** The slice of `navigator.gpu` we use, so tests can supply a fake. */
export interface GpuLike {
  requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<AdapterLike | null>;
}
export interface AdapterLike {
  features: { has(name: string): boolean };
  limits: { maxBufferSize: number; maxStorageBufferBindingSize: number };
  info?: { vendor?: string; architecture?: string; description?: string; device?: string };
  isFallbackAdapter?: boolean;
}

export interface DeviceReport {
  webgpu: boolean;
  /** Human-readable description of the GPU, when the browser shares it. */
  gpu: string | null;
  software: boolean;
  shaderF16: boolean;
  maxBufferSize: number;
  maxStorageBufferBindingSize: number;
  /** Rounded GB of RAM the browser reports (capped at 8 by the browser), or null. */
  memoryGB: number | null;
  storage: { quota: number; usage: number } | null;
  /** Why the model cannot run here, in words for the user. Empty when it can. */
  problems: string[];
}

/** Resolves the adapter, retrying the cold-start null. */
export async function waitForAdapter(gpu: GpuLike | undefined, attempts = 20, delayMs = 500): Promise<AdapterLike | null> {
  if (!gpu) return null;
  for (let i = 0; i < attempts; i++) {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
    if (adapter) return adapter;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/** A model needs a buffer at least this large for its embedding table (the biggest single tensor, in f32 scales). */
const MIN_BUFFER_BYTES = 1024 * 1024 * 1024;

export async function checkDevice(
  env: { gpu?: GpuLike; deviceMemory?: number; storage?: { estimate(): Promise<{ quota?: number; usage?: number }> } } = {
    gpu: (globalThis.navigator as unknown as { gpu?: GpuLike } | undefined)?.gpu,
    deviceMemory: (globalThis.navigator as unknown as { deviceMemory?: number } | undefined)?.deviceMemory,
    storage: globalThis.navigator?.storage,
  },
  retry = { attempts: 20, delayMs: 500 },
): Promise<DeviceReport> {
  const adapter = await waitForAdapter(env.gpu, retry.attempts, retry.delayMs);
  const estimate = await env.storage?.estimate().catch(() => undefined);
  const info = adapter?.info;
  const software = Boolean(adapter?.isFallbackAdapter) || /swiftshader|llvmpipe|software/i.test(`${info?.vendor} ${info?.architecture} ${info?.description}`);

  const report: DeviceReport = {
    webgpu: adapter !== null,
    gpu: adapter ? [info?.vendor, info?.architecture || info?.description].filter(Boolean).join(' ') || 'Unknown GPU' : null,
    software,
    shaderF16: adapter?.features.has('shader-f16') ?? false,
    maxBufferSize: adapter?.limits.maxBufferSize ?? 0,
    maxStorageBufferBindingSize: adapter?.limits.maxStorageBufferBindingSize ?? 0,
    memoryGB: env.deviceMemory ?? null,
    storage: estimate?.quota ? { quota: estimate.quota, usage: estimate.usage ?? 0 } : null,
    problems: [],
  };

  if (!report.webgpu) {
    report.problems.push(
      env.gpu
        ? 'Your browser has WebGPU but could not find a graphics card to use it with. Update your graphics drivers, then reopen this page.'
        : 'Your browser does not support WebGPU, which the on-device model needs. Use a recent version of Chrome, Edge or another Chromium browser.',
    );
  } else if (report.software) {
    report.problems.push('Only a software renderer is available, which is far too slow for the model. Check that hardware acceleration is turned on in your browser settings.');
  } else if (report.maxStorageBufferBindingSize < MIN_BUFFER_BYTES / 2) {
    report.problems.push('Your graphics card reports less memory per buffer than the model needs.');
  }
  return report;
}

/** True when the machine can hold `bytes` more in the browser's storage, with 20% headroom (or when it cannot tell). */
export function hasRoomFor(report: DeviceReport, bytes: number): boolean {
  if (!report.storage) return true;
  return report.storage.quota - report.storage.usage >= bytes * 1.2;
}

export interface Recommendation {
  model: ModelEntry | null;
  /** One sentence for the setup screen. */
  reason: string;
}

/**
 * Picks the starting model. Starts small on purpose: the small model is accurate enough to be useful (see the test
 * scores in the manifest), downloads a fifth as much, and can be swapped for the larger one from the settings page.
 */
export function recommend(models: ModelEntry[], device: DeviceReport): Recommendation {
  const usable = models.filter((m) => !m.requiresShaderF16 || device.shaderF16);
  if (usable.length === 0) {
    return { model: null, reason: models.length ? 'None of the available models run on this graphics card.' : 'The server offers no models yet.' };
  }
  const fast = usable.find((m) => m.tier === 'fast');
  if (fast) return { model: fast, reason: 'Smaller download and quicker on most computers. You can switch to the larger model later.' };
  return { model: usable[0]!, reason: 'The only model available for this graphics card.' };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}
