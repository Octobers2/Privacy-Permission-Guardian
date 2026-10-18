/**
 * Writes <models dir>/manifest.json: the list of model bundles the setup screen offers.
 *
 *   bun run models:manifest [dir]          (default: $PPG_MODELS_DIR or data/models)
 *
 * A bundle is a directory containing `ppg-model.json` (written by ml/compress/write_meta.py) next to the MLC weight
 * files (`tensor-cache.json`, `params_shard_*.bin`, `mlc-chat-config.json`, tokenizer files). Its compiled kernel
 * (`lib`, a .wasm) sits in the models directory itself and can be shared by several bundles.
 *
 * The manifest lists every file with its size and sha256, so the extension can show an honest download size, resume a
 * partial download, and refuse a file that does not match.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? Bun.env.PPG_MODELS_DIR ?? resolve(import.meta.dir, '../data/models'));

function sha256(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', () => ok(hash.digest('hex'))).on('error', fail);
  });
}

async function describe(path: string, name: string) {
  return { path: name, size: statSync(path).size, sha256: await sha256(path) };
}

const libs = new Map<string, Awaited<ReturnType<typeof describe>>>();
const models = [];
for (const entry of readdirSync(dir).sort()) {
  const bundle = join(dir, entry);
  const metaFile = join(bundle, 'ppg-model.json');
  if (!statSync(bundle).isDirectory() || !existsSync(metaFile)) continue;

  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { lib: string; id: string };
  const libPath = join(dir, meta.lib);
  if (!existsSync(libPath)) throw new Error(`${entry}: kernel ${meta.lib} is not in ${dir}`);
  if (!libs.has(meta.lib)) libs.set(meta.lib, await describe(libPath, meta.lib));

  const files = [];
  for (const file of readdirSync(bundle).sort()) {
    if (file === 'ppg-model.json' || !statSync(join(bundle, file)).isFile()) continue;
    files.push(await describe(join(bundle, file), `${entry}/${file}`));
  }
  const lib = libs.get(meta.lib)!;
  models.push({ ...meta, bundle: entry, sizeBytes: files.reduce((n, f) => n + f.size, 0) + lib.size, lib, files });
  console.log(`${meta.id}: ${(models.at(-1)!.sizeBytes / 1e6).toFixed(0)} MB, ${files.length} files`);
}

if (!models.length) throw new Error(`no bundles with a ppg-model.json in ${dir}`);
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), models }, null, 2));
console.log(`wrote ${join(dir, 'manifest.json')}`);
