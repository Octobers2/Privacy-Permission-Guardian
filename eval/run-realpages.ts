/** Segments the real public terms-of-service pages (ml/data/pii_real_negatives.jsonl, fetched by ml/pii/fetch_real_negatives.py)
 *  with the extension's own splitter and writes ml/data/realpages_sentences.jsonl for scoring. */
import { readFileSync, writeFileSync } from 'fs';
import { normalizeForModel, segmentDocument } from '../packages/shared/src/classifier-text.ts';
const dir = new URL('../ml/data/', import.meta.url);
const pages = readFileSync(new URL('pii_real_negatives.jsonl', dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { url: string; text: string });
const terms = pages.filter((p) => /terms|user-agreement|\/ssa|website-terms/i.test(p.url) && p.text.length > 5_000);
const rows = terms.flatMap((p) => segmentDocument(p.text).map((s, i) => ({ url: p.url, i, text: s, normalized: normalizeForModel(s) })));
writeFileSync(new URL('realpages_sentences.jsonl', dir), rows.map((r) => JSON.stringify(r)).join('\n'));
for (const p of terms) {
  const mine = rows.filter((r) => r.url === p.url);
  const lens = mine.map((r) => r.text.length).sort((a, b) => a - b);
  console.log(`${String(mine.length).padStart(5)} sentences, median ${lens[lens.length >> 1]} chars, max ${lens.at(-1)}  ${p.url}`);
}
