/** Step 2 of 3 for unlabelled distillation data: splits ml/data/unlabeled_pages.jsonl (from ml/unlabeled/fetch_pages.py)
 *  with the extension's own splitter and normaliser, so the student learns from exactly the form it will see in use.
 *  Writes ml/data/unlabeled_raw.jsonl: { url, i, text, prev } with text and prev in the model's (corpus-style) form.
 *  run: bun run eval/segment-unlabeled.ts        next: ml/unlabeled/filter.py */
import { readFileSync, writeFileSync } from 'fs';
import { normalizeForModel, segmentDocument } from '../packages/shared/src/classifier-text.ts';

const dir = new URL('../ml/data/', import.meta.url);
const pages = readFileSync(new URL('unlabeled_pages.jsonl', dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { url: string; text: string });
const rows = pages.flatMap((p) => {
  const normalized = segmentDocument(p.text).map(normalizeForModel);
  return normalized.map((text, i) => ({ url: p.url, i, text, prev: i > 0 ? normalized[i - 1]! : '' }));
});
writeFileSync(new URL('unlabeled_raw.jsonl', dir), rows.map((r) => JSON.stringify(r)).join('\n'));
console.log(`${pages.length} pages -> ${rows.length} sentences -> ml/data/unlabeled_raw.jsonl`);
