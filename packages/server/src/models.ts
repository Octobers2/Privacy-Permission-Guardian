/**
 * Serves the compiled model bundles to the extension's setup screen.
 *
 * Layout on disk (the one WebLLM expects, so the extension only needs a base URL):
 *
 *   <PPG_MODELS_DIR>/manifest.json                                   what exists (see scripts/model-manifest.ts)
 *   <PPG_MODELS_DIR>/<bundle>/resolve/main/<file>   <- WebLLM appends "resolve/main/"; we map it to <bundle>/<file>
 *   <PPG_MODELS_DIR>/<model_lib>.wasm
 *
 * Multi-gigabyte files, so: HTTP Range (a dropped download resumes), strong cache headers (the files are immutable once
 * published; a new model gets a new bundle name), and a path check that cannot be talked out of the directory.
 */
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';

export function safePath(root: string, relative: string): string | null {
  // WebLLM requests <bundle>/resolve/main/<file>; on disk the files sit directly in <bundle>/.
  const rel = relative.replace('/resolve/main/', '/');
  if (!rel || rel.includes('\0') || rel.includes('\\') || rel.split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
  const base = resolve(root);
  const full = resolve(base, rel);
  return full.startsWith(base + sep) && extname(full) in TYPES ? full : null;
}

/** Parses a single `bytes=a-b` range. null = no/ignored range, 'invalid' = unsatisfiable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // multi-range or junk: serve the whole file
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? 'invalid' : { start, end };
}

export async function serveModelFile(root: string, relative: string, request: Request): Promise<Response> {
  const path = safePath(root, relative);
  const info = path ? await stat(path).catch(() => null) : null;
  if (!path || !info?.isFile()) return Response.json({ error: 'not_found', message: 'No such model file.' }, { status: 404 });

  const etag = `W/"${info.size}-${Math.floor(info.mtimeMs)}"`;
  const headers = new Headers({
    'content-type': TYPES[extname(path)]!,
    'accept-ranges': 'bytes',
    etag,
    'cache-control': relative === 'manifest.json' ? 'public, max-age=300' : IMMUTABLE,
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-length, content-range, etag',
  });
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });

  const range = parseRange(request.headers.get('range'), info.size);
  if (range === 'invalid') {
    headers.set('content-range', `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  const file = Bun.file(path);
  if (range) {
    headers.set('content-range', `bytes ${range.start}-${range.end}/${info.size}`);
    headers.set('content-length', String(range.end - range.start + 1));
    return new Response(request.method === 'HEAD' ? null : file.slice(range.start, range.end + 1), { status: 206, headers });
  }
  headers.set('content-length', String(info.size));
  return new Response(request.method === 'HEAD' ? null : file, { status: 200, headers });
}
