/**
 * The committed reference hashes, kept apart from the arithmetic in
 * `favicon.ts`.
 *
 * Two importers want the hash function and not the table:
 * `scripts/gen-favicon-hashes.ts`, which is the thing that produces the table,
 * and the unit tests. Keeping the data in its own module means neither drags
 * a JSON file along, and the content script — which must never see either —
 * has one less way to import it by accident.
 *
 * Regenerate with `bun run favicons`. The file is committed rather than
 * fetched at runtime: a detection that depends on being able to reach 177
 * brand sites is a detection that stops working on the day it is needed.
 */
import table from './favicon-hashes.json' with { type: 'json' };
import type { FaviconHashEntry } from './favicon.ts';

export const FAVICON_HASHES: FaviconHashEntry[] = table as FaviconHashEntry[];
