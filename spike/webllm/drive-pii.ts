// usage: bun run drive-pii.ts <mlc-dir> <wasm> <limit> <out.json> : PII question through the real wasm + prompt-mirror check vs Python
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync } from 'fs'
const [dir, wasm, limit, out] = process.argv.slice(2)
const rows = readFileSync(new URL('../../ml/data/pii_test.jsonl', import.meta.url), 'utf8').trim().split('\n').slice(0, Number(limit)).map((l) => JSON.parse(l))
const b = await chromium.launchPersistentContext('/tmp/claude-1000/spike-profile', { executablePath: '/usr/bin/chromium', headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--no-sandbox'] })
const p = b.pages()[0] ?? (await b.newPage())
await p.addInitScript(() => { const o = navigator.gpu.requestAdapter.bind(navigator.gpu); navigator.gpu.requestAdapter = (opts: any = {}) => o({ powerPreference: 'high-performance', ...opts }) })
p.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)))
await p.goto('http://localhost:5199/'); await p.waitForFunction(() => (window as any).__ready)
await p.evaluate(async () => { for (let i = 0; i < 20; i++) { if (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) return; await new Promise((r) => setTimeout(r, 500)) } })
const prompts = await p.evaluate((rs) => rs.map((r: any) => (window as any).piiPromptFor(r.url, r.text)), rows)
writeFileSync(out + '.prompts.json', JSON.stringify(prompts))
const res = await p.evaluate(([d, w, r]) => (window as any).scorePii(d, w, r), [dir, wasm, rows] as const)
writeFileSync(out, JSON.stringify({ dir, n: rows.length, ...res })); console.log(`scored ${rows.length} PII pages in ${res.seconds.toFixed(0)}s`)
await b.close()
