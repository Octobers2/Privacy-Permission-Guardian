import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync } from 'node:fs'
const [file, threads, split, out, limit] = [process.argv[2]!, Number(process.argv[3]), process.argv[4]!, process.argv[5]!, Number(process.argv[6] ?? 1e9)]
const start = Number(process.env.START ?? 0)
const texts = readFileSync(`../../ml/data/${split}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l).text as string).slice(start, start + limit)
const b = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] })
const p = await b.newPage()
await p.exposeFunction('progress', (i: number, ms: number) => console.log(`${split} ${i}/${texts.length} ${(ms / 1000).toFixed(0)}s`))
await p.goto('http://localhost:5198/')
const rows = await p.evaluate(([f, t, x]) => (window as any).runBatch(f, t, x, 100, (i: number, ms: number) => (window as any).progress(i, ms)), [file, threads, texts] as const)
writeFileSync(out, JSON.stringify(rows))
const errs = await p.evaluate(() => (window as any).__errors)
writeFileSync(out + '.errors.json', JSON.stringify(errs, null, 1))
console.log('errors', errs.length, JSON.stringify(errs.slice(0, 3)).slice(0, 600))
console.log('done', rows.length)
await b.close()
