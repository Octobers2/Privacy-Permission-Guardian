/**
 * What the backend's `/models/manifest.json` contains: the model bundles the extension's setup screen can offer.
 * Written by `scripts/model-manifest.ts` from each bundle's `ppg-model.json`.
 */
import { z } from 'zod';
import { LETTERS_PROMPT_VERSION, PII_PROMPT_VERSION } from './classifier-prompt.ts';

const FileSchema = z.object({ path: z.string().min(1), size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

export const ModelEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    tier: z.enum(['fast', 'accurate']),
    version: z.string().min(1),
    quantization: z.string().min(1),
    /** The compiled kernel (`.wasm`), shared between bundles of the same architecture and quantization. */
    lib: FileSchema,
    /** True when the kernel needs the WebGPU `shader-f16` feature, which not every browser/GPU exposes. */
    requiresShaderF16: z.boolean(),
    contextWindow: z.number().int().min(512),
    /** Token ids of the option letters A–I, so the extension never has to download a tokenizer to find them. */
    letterTokenIds: z.array(z.number().int().min(0)).length(9),
    tasks: z
      .object({
        tos: z.object({ promptVersion: z.string(), temperature: z.number().positive(), testMacroF1: z.number().optional() }).strict(),
        pii: z
          .object({ promptVersion: z.string(), threshold: z.number().min(0).max(1), testPrecision: z.number().optional(), testRecall: z.number().optional() })
          .strict()
          .optional(),
      })
      .strict(),
    /** Directory under `/models/` holding the weight files. */
    bundle: z.string().min(1),
    /** Everything the setup screen downloads for this model, kernel included. */
    sizeBytes: z.number().int().min(0),
    files: z.array(FileSchema).min(1),
  })
  .strict();
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

export const ModelManifestSchema = z
  .object({ schema: z.literal(1), generatedAt: z.string().datetime(), models: z.array(ModelEntrySchema) })
  .strict();
export type ModelManifest = z.infer<typeof ModelManifestSchema>;

/** The extension can only use a model whose prompts it knows how to build. */
export function isUsable(model: ModelEntry): boolean {
  return model.tasks.tos.promptVersion === LETTERS_PROMPT_VERSION && (!model.tasks.pii || model.tasks.pii.promptVersion === PII_PROMPT_VERSION);
}
