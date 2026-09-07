/**
 * Measures what the content script actually costs on every page.
 *
 * This has regressed twice already, both times invisibly: once by importing the
 * rule engine (which carries the public suffix list and zod) into the page, and
 * once by importing the `@ppg/shared` barrel before the package declared itself
 * side-effect free. Neither showed up as an error — the extension worked fine,
 * it just quietly added a third of a megabyte to every site the user visits.
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export interface BundleWeight {
  files: { file: string; bytes: number }[];
  total: number;
}

/** Follows the content script's import graph from the manifest. */
export function contentScriptWeight(distDir: string): BundleWeight {
  const manifest = JSON.parse(readFileSync(resolve(distDir, 'manifest.json'), 'utf8')) as {
    content_scripts: { js: string[] }[];
  };

  const loaderPath = resolve(distDir, manifest.content_scripts[0]!.js[0]!);
  const loader = readFileSync(loaderPath, 'utf8');
  // CRXJS injects a loader that dynamically imports the real bundle.
  const entry = /getURL\("([^"]+)"\)/.exec(loader)?.[1];

  const files: { file: string; bytes: number }[] = [];
  const seen = new Set<string>();
  const queue = [entry ? resolve(distDir, entry) : loaderPath];

  while (queue.length) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);

    const source = readFileSync(path, 'utf8');
    files.push({ file: relative(distDir, path), bytes: source.length });

    for (const [, specifier] of source.matchAll(/from\s*["']([^"']+)["']/g)) {
      if (specifier.startsWith('.')) queue.push(resolve(dirname(path), specifier));
    }
  }

  return { files, total: files.reduce((sum, file) => sum + file.bytes, 0) };
}

/**
 * Headroom for the banner and a model verdict, but nothing like enough for a
 * UI framework, the public suffix list or a schema library.
 */
export const CONTENT_SCRIPT_BUDGET_BYTES = 60_000;
