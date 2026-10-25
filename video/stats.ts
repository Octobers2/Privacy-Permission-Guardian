/**
 * The survey numbers the video quotes, computed from the team's spreadsheet.
 *
 *   bun run video/stats.ts "/path/to/PPG Documents.zip"
 *
 * Writes video/data/survey.json: aggregates only, no answers per person (the free-text column is not read). The raw sheet is not
 * kept in the repository.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const zipPath = process.argv[2] ?? '/home/air1507/PPG Documents.zip';
const unzip = (inner: string) => Bun.spawnSync(['unzip', '-p', zipPath, inner], { stdout: 'pipe' }).stdout;

// the xlsx is a zip inside the zip: unpack it to a temp file, then read its two XML parts
const tmp = join(Bun.env.TMPDIR ?? '/tmp', `ppg-survey-${process.pid}.xlsx`);
await Bun.write(tmp, unzip('Cybersecurity survey GenAIC (回覆).xlsx'));
const part = (name: string) => new TextDecoder().decode(Bun.spawnSync(['unzip', '-p', tmp, name], { stdout: 'pipe' }).stdout);

const strings = [...part('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ''));
const rows = [...part('xl/worksheets/sheet1.xml').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
  const row: Record<string, string> = {};
  for (const c of r[1]!.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const col = /r="([A-Z]+)\d+"/.exec(c[1]!)![1]!;
    const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? '')?.[1] ?? '';
    row[col] = /t="s"/.test(c[1]!) && v ? strings[Number(v)]! : v;
  }
  return row;
});
const answers = rows.slice(1);
const n = answers.length;
const count = (column: string, test: (value: string) => boolean) => answers.filter((r) => test(r[column] ?? '')).length;
const pct = (k: number) => Math.round((k / n) * 100);

const read = {
  never: count('B', (v) => /Never/.test(v)),
  rarely: count('B', (v) => /Rarely/.test(v)),
  skim: count('B', (v) => /Skim/.test(v)),
  always: count('B', (v) => /Always/.test(v)),
};
const reasons = {
  tooLong: count('C', (v) => /Too long/.test(v)),
  forced: count('C', (v) => /forced to accept/.test(v)),
  jargon: count('C', (v) => /legal jargon/.test(v)),
  trust: count('C', (v) => /Trust standard/.test(v)),
};
const concern = answers.map((r) => Number(r.D)).filter((x) => x > 0);
const visitedDangerous = count('E', (v) => /Yes/.test(v));

const out = {
  n,
  neverOrRarely: { count: read.never + read.rarely, percent: pct(read.never + read.rarely) },
  neverReadInFull: { count: n - read.always, percent: pct(n - read.always) },
  read,
  reasons: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, { count: v, percent: pct(v) }])),
  privacyConcern: { average: Math.round((concern.reduce((a, b) => a + b, 0) / concern.length) * 10) / 10, scale: '1 to 5', fourOrFive: { count: concern.filter((x) => x >= 4).length, percent: pct(concern.filter((x) => x >= 4).length) } },
  visitedDangerousSite: { count: visitedDangerous, percent: pct(visitedDangerous) },
};
mkdirSync(resolve(import.meta.dir, 'data'), { recursive: true });
writeFileSync(resolve(import.meta.dir, 'data/survey.json'), JSON.stringify(out, null, 2) + '\n');
writeFileSync(resolve(import.meta.dir, 'data/survey.js'), `window.SURVEY = ${JSON.stringify(out)};\n`); // for the scenes, which are plain pages
console.log(out);
