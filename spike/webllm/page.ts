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


// ---- parity harness: score passages with a self-hosted MLC dir through the real wasm, return raw letter logits ----
const NAMES9 = ['limitation of liability','contract by using','unilateral change','arbitration','content removal','choice of law','other','unilateral termination','jurisdiction']
const letterPrompt = (p: string) =>
  `Classify this terms-of-service passage.\n${NAMES9.map((n, i) => `${LETTERS[i]}) ${n}`).join('\n')}\n\nPassage: ${p.trim()}\nAnswer:`   // mirror of ml/prompt.py letter_prompt (letters-v1)

async function scoreSelfHosted(dir: string, wasm: string, texts: string[]) {
  const tap = new LetterTap()
  const id = 'self:' + dir
  const appConfig = { model_list: [{ model: `${location.origin}/models/${dir}`, model_id: id, model_lib: `${location.origin}/models/${wasm}`, overrides: { context_window_size: 4096 } }] }
  let engine: webllm.MLCEngine
  try { engine = await webllm.CreateMLCEngine(id, { appConfig, logitProcessorRegistry: new Map([[id, tap]]), initProgressCallback: (r) => (window as any).__log.push(r.text.slice(0, 120)) }) }
  catch (e: any) {
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    throw new Error(`engine failed: ${e?.name}: ${String(e?.message).slice(0, 160)} | cause=${e?.cause} | adapter=${a ? a.info.vendor : 'null'} maxBuf=${a?.limits.maxBufferSize} maxStor=${a?.limits.maxStorageBufferBindingSize} | log=${JSON.stringify((window as any).__log.slice(-6))}`)
  }
  const tok = await (await fetch(`${location.origin}/models/${dir}/resolve/main/tokenizer.json`)).json()
  tap.ids = LETTERS.map((l) => tok.model.vocab['Ġ' + l])
  const out: number[][] = []
  const t0 = performance.now()
  for (const t of texts) {
    await engine.resetChat()
    await engine.completions.create({ prompt: letterPrompt(t), max_tokens: 1, temperature: 0 })
    out.push(tap.last!)
  }
  await engine.unload()
  return { logits: out, seconds: (performance.now() - t0) / 1000 }
}
;(window as any).scoreSelfHosted = scoreSelfHosted


// ---- PII question (mirror of ml/prompt.py pii_prompt, version pii-v1): A = personal, B = public ----
function piiPrompt(url: string, text: string) {
  const u = new URL(url)
  let path = u.pathname
  try { path = decodeURIComponent(path) } catch { /* malformed escape: keep as is */ }
  const where = `${u.host}${path}`                                         // never the query string; decoded like the Python side
  const page = text.split(/\s+/).filter(Boolean).join(' ').slice(0, 1200)
  return 'Decide whether this web page shows private information about the person using it ' +
    '(their account, orders, messages, health, finances, contact or ID details) or is a public page.\n' +
    `A) personal\nB) public\n\nPage address: ${where}\nPage text: ${page}\nAnswer:`
}
async function scorePrompts(dir: string, wasm: string, prompts: string[], nLetters: number) {
  const tap = new LetterTap(); const id = 'self:' + dir
  const appConfig = { model_list: [{ model: `${location.origin}/models/${dir}`, model_id: id, model_lib: `${location.origin}/models/${wasm}`, overrides: { context_window_size: 4096 } }] }
  const engine = await webllm.CreateMLCEngine(id, { appConfig, logitProcessorRegistry: new Map([[id, tap]]) })
  const tok = await (await fetch(`${location.origin}/models/${dir}/resolve/main/tokenizer.json`)).json()
  tap.ids = LETTERS.slice(0, nLetters).map((l) => tok.model.vocab['Ġ' + l])
  const out: number[][] = []; const t0 = performance.now()
  for (const p of prompts) { await engine.resetChat(); await engine.completions.create({ prompt: p, max_tokens: 1, temperature: 0 }); out.push(tap.last!) }
  await engine.unload()
  return { logits: out, seconds: (performance.now() - t0) / 1000 }
}
;(window as any).scorePii = (dir: string, wasm: string, rows: { url: string; text: string }[]) => scorePrompts(dir, wasm, rows.map((r) => piiPrompt(r.url, r.text)), 2)
;(window as any).piiPromptFor = (url: string, text: string) => piiPrompt(url, text)
