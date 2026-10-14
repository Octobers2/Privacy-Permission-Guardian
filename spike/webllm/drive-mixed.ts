import { chromium } from 'playwright-core'
const [dir, wasm, pattern, longChars] = process.argv.slice(2)
const b = await chromium.launchPersistentContext('/tmp/claude-1000/spike-profile', { executablePath: '/usr/bin/chromium', headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--no-sandbox'] })
const p = b.pages()[0] ?? (await b.newPage())
await p.addInitScript(() => { const o = navigator.gpu.requestAdapter.bind(navigator.gpu); navigator.gpu.requestAdapter = (opts: any = {}) => o({ powerPreference: 'high-performance', ...opts }) })
await p.goto('http://localhost:5199/'); await p.waitForFunction(() => (window as any).__ready)
await p.evaluate(async () => { for (let i = 0; i < 20; i++) { if (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) return; await new Promise((r) => setTimeout(r, 500)) } })
console.log(await p.evaluate(([d, w, pat, n]) => (window as any).runPattern(d, w, pat, Number(n)), [dir, wasm, pattern, longChars] as const))
await b.close()
