import { chromium } from 'playwright-core'
const model = process.argv[2] ?? 'Qwen3.5-0.8B-q4f16_1-MLC'
const b = await chromium.launchPersistentContext('/tmp/claude-1000/spike-profile', { executablePath: '/usr/bin/chromium', headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--no-sandbox'] })
const p = b.pages()[0] ?? await b.newPage()
// WebLLM asks for the default adapter; make that the discrete GPU
await p.addInitScript(() => { const o = navigator.gpu.requestAdapter.bind(navigator.gpu); navigator.gpu.requestAdapter = (opts: any = {}) => o({ powerPreference: 'high-performance', ...opts }) })
p.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)) })
p.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)))
await p.goto('http://localhost:5199/')
await p.waitForFunction(() => (window as any).__ready)
console.log(await p.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter()
  return a ? `adapter ${a.info.vendor}/${a.info.architecture} f16=${a.features.has('shader-f16')}` : 'NO WEBGPU ADAPTER'
}))
try {
  await p.evaluate((m) => (window as any).runSpike(m), model)
} catch (e: any) { console.log('FAILED:', e.message.slice(0, 500)) }
console.log((await p.evaluate(() => (window as any).__log)).join('\n'))
await b.close()
