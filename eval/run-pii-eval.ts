/**
 * Runs the rule-based PII layer over a labelled JSONL file ({url,text,label:1=personal,0=public,...}) and reports
 * per-set precision/recall. Prints counts and reasons only, never the matched values.
 * usage: bun run eval/run-pii-eval.ts ml/data/pii_real_negatives.jsonl [more.jsonl …] [--verbose]
 */
import { readFileSync } from 'fs';
import { assessPage, passageHasPii } from '../packages/shared/src/pii.ts';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
for (const file of args.filter((a) => !a.startsWith('--'))) {
  const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { url: string; text: string; label: number; kind?: string });
  const usable = rows.filter((r) => r.text.length > 2000 || r.label === 1 || r.kind);
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const miss: string[] = [];
  for (const r of usable) {
    const a = assessPage({ url: r.url, text: r.text });
    if (a.personal && r.label === 1) tp++;
    else if (a.personal) { fp++; miss.push(`FP ${r.url} :: ${a.reasons.join('; ')}`); }
    else if (r.label === 1) { fn++; miss.push(`FN ${r.url} (${r.kind ?? ''}) :: ${a.reasons.join('; ') || 'nothing found'}`); }
    else tn++;
  }
  const p = tp / Math.max(tp + fp, 1), rc = tp / Math.max(tp + fn, 1);
  console.log(`${file}: n=${usable.length} TP=${tp} FP=${fp} FN=${fn} TN=${tn}  precision=${p.toFixed(3)} recall=${rc.toFixed(3)}`);
  if (verbose || miss.length <= 12) for (const m of miss.slice(0, 40)) console.log('  ' + m);
  // strict passage check on the same texts: how many 600-char windows would be dropped from an upload?
  const windows = usable.filter((r) => r.label === 0).flatMap((r) => r.text.match(/.{1,600}(\s|$)/g) ?? []);
  console.log(`  passage gate would drop ${windows.filter(passageHasPii).length} of ${windows.length} windows from public pages`);
}
