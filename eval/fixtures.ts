/**
 * Loads the labelled fixture set.
 *
 * `labels.csv` is the single source of truth for what a fixture *is*: which
 * file holds it, the URL it should be judged as, and whether a human labelled
 * it phishing. The evaluation harness and the local fixture server both read
 * it, so a demo and a measurement can never disagree about a fixture.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Where a fixture came from.
 *
 * This distinction is the difference between a measurement and a circular one.
 * `synthetic` fixtures were written by us, and we wrote them while looking at
 * the rules — scoring well on them says almost nothing. `collected` fixtures
 * are snapshots of pages nobody on this project authored, and only those
 * belong in a headline number.
 */
export type FixtureSource = 'synthetic' | 'collected';

export interface Fixture {
  file: string;
  url: string;
  label: 'legit' | 'phishing';
  notes: string;
  source: FixtureSource;
  hostname: string;
  protocol: 'http:' | 'https:';
  path: string;
}

export const EVAL_DIR = import.meta.dir;

/** Minimal RFC 4180 reader — enough for a hand-maintained label file. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

export function loadFixtures(): Fixture[] {
  const [header, ...rows] = parseCsv(readFileSync(resolve(EVAL_DIR, 'labels.csv'), 'utf8'));
  const columns = header!.map((h) => h.trim());

  return rows.map((row) => {
    const record = Object.fromEntries(columns.map((c, i) => [c, row[i] ?? '']));
    const url = new URL(record.url!);
    return {
      file: record.file!,
      url: record.url!,
      label: record.label as Fixture['label'],
      notes: record.notes ?? '',
      source: (record.source as FixtureSource) || 'synthetic',
      hostname: url.hostname,
      protocol: url.protocol as Fixture['protocol'],
      path: url.pathname,
    };
  });
}

export function fixtureHtml(fixture: Fixture): string {
  return readFileSync(resolve(EVAL_DIR, 'fixtures', fixture.file), 'utf8');
}
