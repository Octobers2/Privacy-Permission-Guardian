import { Wllama } from '@wllama/wllama'
import { letterPrompt } from '../../packages/shared/src/classifier-prompt.ts'

const log: string[] = []
const say = (s: string) => { log.push(s); document.getElementById('o')!.textContent = log.join('\n') }
;(window as any).__log = log

const passages = [
  'We may terminate your account at any time, for any reason, without notice, and you will not be entitled to a refund.',
  'You agree that all disputes will be resolved by binding arbitration and you waive any right to a class action.',
  'We may change these terms at any time by posting the new version on this page; continued use means you accept them.',
  'The service is provided as is, without warranty of any kind, and our liability is limited to the fees you paid in the last month.',
  'We may share your information with our partners for marketing purposes without asking you again.',
  'These terms are governed by the laws of the State of Delaware and any suit must be brought in its courts.',
]
const lets = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']

;(window as any).runSpike = async (file: string, threads: number, topN: number) => {
  say(`crossOriginIsolated=${crossOriginIsolated} cores=${navigator.hardwareConcurrency} file=${file} threads=${threads}`)
  const w = new Wllama({ default: '/wllama.wasm' } as any)
  let t0 = performance.now()
  await w.loadModelFromUrl(`/gguf/${file}`, { n_ctx: 1024, n_threads: threads, n_batch: 512 } as any)
  say(`loaded in ${(performance.now() - t0).toFixed(0)} ms`)
  let total = 0
  for (const [i, text] of passages.entries()) {
    t0 = performance.now()
    const out: any = await w.createCompletion({ prompt: letterPrompt(text), max_tokens: 1, temperature: 0, logprobs: topN } as any)
    const ms = performance.now() - t0
    if (i > 0) total += ms
    const top = out.choices[0].logprobs.content[0].top_logprobs
    const found = lets.map((l) => top.find((x: any) => x.token === ' ' + l)?.logprob)
    say(`p${i}: ${ms.toFixed(0)} ms prompt_n=${out.timings.prompt_n} cache_n=${out.timings.cache_n} letters=${found.map((x: any) => (x === undefined ? '-' : x.toFixed(2))).join(' ')}`)
  }
  say(`avg per passage (excluding first): ${(total / (passages.length - 1)).toFixed(0)} ms`)
}

;(window as any).runBatch = async (file: string, threads: number, texts: string[], topN: number, onProgress: (i: number, ms: number) => void) => {
  const make = async () => {
    const w = new Wllama({ default: '/wllama.wasm' } as any)
    await w.loadModelFromUrl(`/gguf/${file}`, { n_ctx: 1024, n_threads: threads, n_batch: 512 } as any)
    return w
  }
  let w = await make()
  const rows: (number | null)[][] = []
  const errors: { i: number; message: string; sinceReload: number }[] = []
  let sinceReload = 0
  const t0 = performance.now()
  const ask = async (text: string) => {
    const out: any = await w.createCompletion({ prompt: letterPrompt(text), max_tokens: 1, temperature: 0, logprobs: topN } as any)
    const top = out.choices[0].logprobs.content[0].top_logprobs
    return lets.map((l) => top.find((x: any) => x.token === ' ' + l)?.logprob ?? null)
  }
  for (const [i, text] of texts.entries()) {
    try {
      rows.push(await ask(text))
    } catch (e: any) {
      errors.push({ i, message: String(e?.message ?? e).slice(0, 160), sinceReload })
      await w.exit().catch(() => {})
      w = await make()
      sinceReload = 0
      try { rows.push(await ask(text)) } catch { rows.push(lets.map(() => null)) }
    }
    sinceReload++
    if (i % 50 === 0) onProgress(i, performance.now() - t0)
  }
  ;(window as any).__errors = errors
  return rows
}
