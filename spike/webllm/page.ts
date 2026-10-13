import * as webllm from '@mlc-ai/web-llm'

const LETTERS = 'ABCDEFGHI'.split('')
const log = (m: string) => { (window as any).__log.push(m); document.getElementById('o')!.textContent += m + '\n' }
;(window as any).__log = []

// Captures the raw logits of the 9 letter tokens at the first generated position.
class LetterTap implements webllm.LogitProcessor {
  ids: number[] = []
  last: number[] | null = null
  processLogits(logits: Float32Array) { this.last = this.ids.map((i) => logits[i]); return logits }
  processSampledToken() {}
  resetState() {}
}

const PASSAGES = [
  'you agree that any claim or dispute must be resolved exclusively by a court located in helsinki , finland .',
  'we may terminate your account at any time , for any reason , without notice .',
  'the service is provided on an as is basis and we are not liable for any loss of data .',
  'you will not share your password .',
]
const OPTIONS = ['limitation of liability','contract by using','unilateral change','arbitration','content removal','choice of law','other','unilateral termination','jurisdiction']
const INSTR = 'Classify the terms-of-service passage into one category.\n\n' + OPTIONS.map((o, i) => `${LETTERS[i]}) ${o}`).join('\n') + '\n\n'
const prompt = (p: string) => `${INSTR}Passage: ${p}\nAnswer:`

async function run(modelId: string) {
  const tap = new LetterTap()
  const registry = new Map([[modelId, tap]])
  const t0 = performance.now()
  const selfHosted = modelId.startsWith('self:')
  const appConfig = selfHosted ? { model_list: [{
    model: location.origin + '/models/' + modelId.slice(5), model_id: modelId,
    model_lib: location.origin + '/models/Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm', overrides: { context_window_size: 4096 } }] } : webllm.prebuiltAppConfig
  const engine = await webllm.CreateMLCEngine(modelId, {
    appConfig,
    initProgressCallback: (r) => { if (/finish/i.test(r.text)) log(`  ${r.text.slice(0, 80)}`) },
    logitProcessorRegistry: registry,
  })
  log(`${modelId}: loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`)

  // Resolve letter token ids from the model's own tokenizer.json
  const base = appConfig.model_list.find((m: any) => m.model_id === modelId)!.model
  const tok = await (await fetch(`${base}/resolve/main/tokenizer.json`)).json()
  const vocab = tok.model.vocab as Record<string, number>
  tap.ids = LETTERS.map((l) => vocab['Ġ' + l])
  log(`letter ids: ${tap.ids.join(',')}`)
  if (tap.ids.some((i) => i === undefined)) throw new Error('letter token missing from vocab')

  const out: any[] = []
  for (const [k, p] of PASSAGES.entries()) {
    const t = performance.now()
    await engine.resetChat()
    await engine.completions.create({ prompt: prompt(p), max_tokens: 1, temperature: 0 })
    const ms = performance.now() - t
    const lg = tap.last!
    const m = Math.max(...lg), e = lg.map((x) => Math.exp(x - m)), s = e.reduce((a, b) => a + b, 0)
    const probs = e.map((x) => x / s)
    const top = probs.indexOf(Math.max(...probs))
    log(`#${k} ${ms.toFixed(0)}ms -> ${LETTERS[top]} ${OPTIONS[top]} (${probs[top].toFixed(2)}) | ${p.slice(0, 40)}`)
    out.push({ ms, top, probs })
  }
  await engine.unload()
  return out
}
;(window as any).runSpike = run
;(window as any).__ready = true
