// usage: bun run drive-eval.ts <mlc-dir-name> <wasm-file> <limit> <out.json>   (MODEL_ROOT must contain both; served by serve.ts)
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync } from 'fs'
const [dir, wasm, limit, out] = process.argv.slice(2)
const rows = readFileSync(new URL('../../ml/data/test.jsonl', import.meta.url), 'utf8').trim().split('\n').slice(0, Number(limit)).map((l) => JSON.parse(l))
const b = await chromium.launchPersistentContext('/tmp/claude-1000/spike-profile', { executablePath: '/usr/bin/chromium', headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--no-sandbox'] })
const p = b.pages()[0] ?? (await b.newPage())
const MODELS_BASE = process.env.MODELS_BASE
if (MODELS_BASE) await p.addInitScript((b) => { (window as any).__modelsBase = b }, MODELS_BASE)
await p.addInitScript(() => { const o = navigator.gpu.requestAdapter.bind(navigator.gpu); navigator.gpu.requestAdapter = (opts: any = {}) => o({ powerPreference: 'high-performance', ...opts }) })
p.on('console', (m) => { if (['error','warning'].includes(m.type())) console.log('[console.' + m.type() + ']', m.text().slice(0, 400)) })
p.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)))
await p.goto('http://localhost:5199/')
await p.waitForFunction(() => (window as any).__ready)
// the first requestAdapter on a cold page can return null while the GPU process starts: warm up (with retries) before WebLLM asks
console.log('adapter warm-up:', await p.evaluate(async () => { for (let i = 0; i < 20; i++) { if (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) return 'ok after ' + i + ' tries'; await new Promise((r) => setTimeout(r, 500)) } return 'never' }))
const res = await p.evaluate(([d, w, t]) => (window as any).scoreSelfHosted(d, w, t), [dir, wasm, rows.map((r: any) => r.text)] as const)
writeFileSync(out, JSON.stringify({ dir, wasm, n: rows.length, ...res }))
console.log(`scored ${rows.length} passages in ${res.seconds.toFixed(0)}s -> ${out}`)
await b.close()
