import { chromium } from 'playwright-core'
const [file, threads, ids] = [process.argv[2]!, Number(process.argv[3] ?? 4), Number(process.argv[4] ?? 100)]
const b = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] })
const p = await b.newPage()
p.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)) })
p.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)))
await p.goto('http://localhost:5198/')
try { await p.evaluate(([f, t, i]) => (window as any).runSpike(f, t, i), [file, threads, ids] as const) } catch (e: any) { console.log('FAILED:', e.message.slice(0, 600)) }
console.log((await p.evaluate(() => (window as any).__log)).join('\n'))
await b.close()
