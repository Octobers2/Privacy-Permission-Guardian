/**
 * Writes ml/data/test_natural_normalized.jsonl: the "natural" test sentences (ml/make_natural.py) after the extension's own
 * normalizeForModel. Scoring it next to test.jsonl (the original) and test_natural.jsonl (no normalisation) shows what the
 * page-text pipeline costs the classifier.   bun run eval/run-normalize-eval.ts
 */
import { readFileSync, writeFileSync } from 'fs';
import { normalizeForModel } from '../packages/shared/src/classifier-text.ts';

const dir = new URL('../ml/data/', import.meta.url);
const rows = readFileSync(new URL('test_natural.jsonl', dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { text: string; label_name: string });
const orig = readFileSync(new URL('test.jsonl', dir), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { text: string }).text.trim());
const out = rows.map((r) => ({ text: normalizeForModel(r.text), label_name: r.label_name }));
const same = out.filter((r, i) => r.text === orig[i]).length;
writeFileSync(new URL('test_natural_normalized.jsonl', dir), out.map((r) => JSON.stringify(r)).join('\n'));
console.log(`normalised ${out.length} sentences; identical to the original corpus text: ${same} (${((same / out.length) * 100).toFixed(1)}%)`);
