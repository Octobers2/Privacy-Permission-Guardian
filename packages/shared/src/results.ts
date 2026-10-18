/**
 * The shared result: what a trusted user's extension uploads, and what the public API and the query site read back.
 *
 * Only passages the classifier flagged as potentially unfair are sent, with their text; fair passages travel as a count.
 * Every schema is `.strict()` and none has a field that could carry a page's own content beyond those passages.
 */
import { z } from 'zod';
import { OTHER_INDEX, TOS_CATEGORIES, UNFAIR_CATEGORIES } from './labels.ts';

export const RESULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_PASSAGES = 500;
export const MAX_PASSAGE_CHARS = 2_000;
export const CLASSIFIER_PROMPT_VERSION = 'letters-v1';

const UnfairCategorySchema = z.enum(UNFAIR_CATEGORIES);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha256 hex digest');

/** A policy URL carries no query string or fragment: those are where session tokens and tracking ids live. */
const PolicyUrl = z
  .string()
  .max(2_048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'http(s) only')
  .refine((u) => {
    const parsed = new URL(u);
    return parsed.search === '' && parsed.hash === '' && parsed.username === '' && parsed.password === '';
  }, 'strip the query string, fragment and credentials before sending');

export const PassageBase = z
  .object({
    index: z.number().int().min(0).max(100_000),
    text: z.string().min(1).max(MAX_PASSAGE_CHARS),
    category: UnfairCategorySchema,
    /** Calibrated probabilities over all nine classes, in `TOS_CATEGORIES` order. */
    probs: z.array(z.number().min(0).max(1)).length(TOS_CATEGORIES.length),
  })
  .strict();

export const PassageSchema = PassageBase.refine((p) => Math.abs(p.probs.reduce((a, b) => a + b, 0) - 1) < 0.02, { message: 'probs must sum to 1', path: ['probs'] })
  .refine((p) => p.probs.indexOf(Math.max(...p.probs)) === TOS_CATEGORIES.indexOf(p.category), {
    message: 'category must be the most probable class',
    path: ['category'],
  })
  .refine((p) => p.probs[OTHER_INDEX]! < 0.5, { message: 'a flagged passage cannot be mostly "other"', path: ['probs'] });
export type Passage = z.infer<typeof PassageSchema>;

export const ModelRefSchema = z
  .object({ id: z.string().min(1).max(80), version: z.string().min(1).max(40) })
  .strict();

export const ResultUploadSchema = z
  .object({
    url: PolicyUrl,
    domain: z.string().min(1).max(253),
    /** sha256 of the policy text the classifier read; changes when the terms change. */
    textHash: Sha256,
    model: ModelRefSchema,
    promptVersion: z.string().min(1).max(40),
    /** Passages the document was split into, flagged or not. */
    passageCount: z.number().int().min(1).max(100_000),
    passages: z.array(PassageSchema).max(MAX_PASSAGES),
  })
  .strict()
  .refine((r) => r.passages.length <= r.passageCount, { message: 'more flagged passages than passages', path: ['passages'] });
export type ResultUpload = z.infer<typeof ResultUploadSchema>;

export const CategoryCountsSchema = z.record(UnfairCategorySchema, z.number().int().min(0)).default({});

export const ResultViewSchema = z
  .object({
    id: z.number().int(),
    url: z.string().url(),
    domain: z.string(),
    textHash: Sha256,
    model: ModelRefSchema,
    promptVersion: z.string(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    passageCount: z.number().int(),
    unfairCount: z.number().int(),
    fairCount: z.number().int(),
    categories: CategoryCountsSchema,
    passages: z.array(PassageSchema),
    /** False for older versions of the same policy URL (history). */
    current: z.boolean(),
  })
  .strict();
export type ResultView = z.infer<typeof ResultViewSchema>;

/** The list shape: everything but the passage text. */
export const ResultSummaryViewSchema = ResultViewSchema.omit({ passages: true });
export type ResultSummaryView = z.infer<typeof ResultSummaryViewSchema>;

export interface RankingRow {
  domain: string;
  documents: number;
  unfair: number;
  passages: number;
  /** unfair / passages across the domain's current documents. */
  share: number;
  latest: string;
}
