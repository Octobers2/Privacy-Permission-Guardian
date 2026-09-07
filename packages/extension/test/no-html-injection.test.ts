/**
 * Guards the last of the five injection defences.
 *
 * Model output is derived from attacker-controlled page text, and it flows into
 * the banner and the popup. If any of it were ever assigned to `innerHTML` or
 * rendered with `{@html}`, a site could turn "summarise my privacy policy" into
 * script execution inside the extension's own origin, where `chrome.*` is
 * reachable.
 *
 * The rule is absolute rather than case-by-case on purpose: "innerHTML, but
 * only with a literal" is a rule nobody can enforce in review six months from
 * now, and the cost of never using it is a handful of createElement calls.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOTS = [
  resolve(import.meta.dir, '../src'),
  resolve(import.meta.dir, '../../shared/src'),
  resolve(import.meta.dir, '../../server/src'),
];

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /\{@html\b/, why: 'Svelte {@html} renders unescaped markup' },
  { pattern: /\.innerHTML\s*=/, why: 'assigning innerHTML parses markup' },
  { pattern: /\.outerHTML\s*=/, why: 'assigning outerHTML parses markup' },
  { pattern: /insertAdjacentHTML\s*\(/, why: 'insertAdjacentHTML parses markup' },
  { pattern: /document\.write\s*\(/, why: 'document.write parses markup' },
  { pattern: /\bnew Function\s*\(/, why: 'new Function evaluates code' },
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|svelte)$/.test(entry)) found.push(path);
  }
  return found;
}

describe('no markup is ever parsed from a string', () => {
  const files = ROOTS.flatMap(sourceFiles);

  test('there are source files to check', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  for (const { pattern, why } of FORBIDDEN) {
    test(`no ${pattern.source} — ${why}`, () => {
      const offenders = files
        .filter((file) => pattern.test(readFileSync(file, 'utf8')))
        .map((file) => relative(resolve(import.meta.dir, '../../..'), file));
      expect(offenders).toEqual([]);
    });
  }
});
