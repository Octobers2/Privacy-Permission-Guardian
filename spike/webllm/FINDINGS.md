# WebLLM feasibility spike (2026-10-13)

Run: `bun install && bun run serve.ts &` then `bun run drive.ts <model-id>` (headless system Chromium 153, RTX 5060 Ti).

## Confirmed
- WebLLM 0.2.86 ships prebuilt `qwen35` wasm libs (0.8B/2B/4B/9B, q4f16_1 / q4f32_1). Fine-tuned weights with the same arch + quant can reuse them, so no compile step for q4.
- `top_logprobs` is capped at 5, which can't cover 9 classes. A `LogitProcessor` gets the raw logits on the CPU, so we read the 9 letter logits ("Ġ"+A..I from tokenizer.json) and softmax them ourselves. Register it as `logitProcessorRegistry: Map<modelId, processor>` in the engine config, call `completions.create({prompt, max_tokens: 1})`.
- Untrained Qwen3.5-4B-q4f32_1 already gets 3/4 sanity passages right zero-shot. ~420 ms/passage (~190 prompt tokens, no prefix caching), 0.8B ~90 ms.
- Self-hosting works: model URL `<origin>/models/<id>`, WebLLM requests `<url>/resolve/main/<file>`, plus `model_lib` pointing at our own .wasm. Needs CORS; immutable caching is fine.

## Gotchas that shape the design
1. **Set `overrides.context_window_size: 4096`** (or bake it into mlc-chat-config.json at export). The default is 262144 and the device is lost at load (OOM).
2. **No shader-f16 on NVIDIA/Linux in this Chromium** even though Vulkan reports it (AMD iGPU has it). q4f16_1 needs it; the wizard must check `adapter.features.has('shader-f16')` and fall back to q4f32_1. A `q3f16_1` build would need an f32 variant too.
3. Headless Chromium needs `--use-angle=vulkan` and `requestAdapter({powerPreference:'high-performance'})`, otherwise it falls to SwiftShader (looks like a shader-compile error).
4. Cache Storage quota: ephemeral profiles fail for multi-GB weights. Real installs are fine; test harnesses need a persistent profile.

## Not yet verified
- q3f16_1 compile for qwen35 (MLC has the preset, group size 40; needs the mlc_llm + emscripten toolchain).
- Prefix-caching the shared instruction block.
- A merged fine-tuned checkpoint loading under the stock wasm (needs trained weights).

## Added 2026-10-14
- **Cold-start adapter race**: the first `navigator.gpu.requestAdapter({powerPreference:'high-performance'})` on a fresh page can return null, and WebLLM's `detectGPUDevice` treats that as fatal ("Unable to find a compatible GPU"). A second call succeeds. The extension must retry adapter detection before creating the engine (see `drive-eval.ts`).
- **Packed fine-tuned weights run on the stock prebuilt wasm** (`Qwen3.5-4B-q4f32_1_cs1k-webgpu.wasm`): 300 test passages, argmax agreement with PyTorch fake-quant 100%, mean |logit diff| 0.019, ~480 ms/passage (f32, no prefix caching). Packer: `ml/compress/pack_mlc.py`.
- `mlc_llm convert_weight` / wasm compile are broken on qwen3_5 in the current nightly (needs `apache-tvm-ffi==0.1.13`, then fails in `create_rnn_state`), so new wasm builds (e.g. q3f16_1) are blocked.
