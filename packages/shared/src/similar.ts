/**
 * "Seen on N other sites": for a flagged clause, the same kind of clause already stored for other sites.
 *
 * Retrieval over the shared results, not a model: the server matches the words of the sentence against the stored sentences of the
 * same clause type. What comes back is public data (stored sentences of other sites), so a lookup reveals nothing but what was asked.
 */
import { z } from 'zod';
import { UNFAIR_CATEGORIES } from './labels.ts';
import { MAX_PASSAGE_CHARS } from './results.ts';

export const MAX_SIMILAR_REQUEST = 50;
export const MAX_SIMILAR_EXAMPLES = 3;
/** Words in common, over words in either, below which two sentences are not called similar. */
export const SIMILAR_THRESHOLD = 0.35;

export const SimilarRequestSchema = z
  .object({
    /** The site the clauses came from, so its own stored versions are not counted as "other sites". */
    domain: z.string().max(253).optional(),
    passages: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(100_000),
            category: z.enum(UNFAIR_CATEGORIES),
            text: z.string().min(1).max(MAX_PASSAGE_CHARS),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_SIMILAR_REQUEST),
  })
  .strict();
export type SimilarRequest = z.infer<typeof SimilarRequestSchema>;

export const SimilarItemSchema = z
  .object({
    /** The position of the asking sentence, as sent. */
    index: z.number().int(),
    /** How many other sites have a similar clause. */
    sites: z.number().int().min(1),
    examples: z
      .array(z.object({ domain: z.string(), url: z.string(), text: z.string().max(MAX_PASSAGE_CHARS) }).strict())
      .max(MAX_SIMILAR_EXAMPLES),
  })
  .strict();
export type SimilarItem = z.infer<typeof SimilarItemSchema>;

export const SimilarResponseSchema = z.object({ items: z.array(SimilarItemSchema) }).strict();
export type SimilarResponse = z.infer<typeof SimilarResponseSchema>;

const STOP = new Set(
  'the and for you your are not may any all can will with that this from our its has have been was were shall such than then them they their these those which who whom whose into upon under over about out but nor yet per via use used using'.split(' '),
);

/** The distinct meaningful lower-case words of a sentence. Shared by the query builder and the similarity score so they agree. */
export function significantWords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)))];
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const set = new Set(a);
  let shared = 0;
  for (const w of new Set(b)) if (set.has(w)) shared++;
  return shared / (set.size + new Set(b).size - shared);
}
