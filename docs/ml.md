# The classifier: data, training, packaging

Everything under [`ml/`](../ml) is Python and runs offline. Its only output that the rest of the project consumes is a **model bundle** in `data/models`: 4-bit weights in MLC format, a `ppg-model.json`, and the tokenizer. The numbers it produced are in [evaluation.md](evaluation.md).

## What is being learned

Given one sentence of a terms-of-service document, pick one of nine classes. The order is fixed everywhere (`ml/labels.json`, `packages/shared/src/labels.ts`):

`limitation_of_liability`, `contract_by_using`, `unilateral_change`, `arbitration`, `content_removal`, `choice_of_law`, `other`, `unilateral_termination`, `jurisdiction`

Eight are kinds of potentially unfair clause; `other` is everything else, and is by far the most common (90% of the benchmark). A second, separate question is also trained: does this web page show the personal data of the person using it? (two options, `personal` and `public`). It decides whether results may leave the device.

The model is asked a multiple-choice question and answers with a single letter. Instead of generating, the code reads the logits of the nine option letters (`A` to `I`) and turns them into probabilities, so the answer is a distribution rather than a guess. The prompt (`letters-v1`) is short:

```
Classify this terms-of-service passage.
A) limitation of liability
B) contract by using
…
I) jurisdiction

Passage: <sentence>
Answer:
```

The personal-data prompt (`pii-v1`) shows the page address (host and path only) and the first 1,200 characters of the page text. Both prompts are defined in `ml/prompt.py` and mirrored in `packages/shared/src/classifier-prompt.ts`; golden files keep them identical (see [architecture.md](architecture.md)).

## Data

| Split | Source | Size |
|---|---|---|
| test | [`mteb/UnfairTOSLegalBenchClassification`](https://huggingface.co/datasets/mteb/UnfairTOSLegalBenchClassification), untouched | 2,048 (1,855 other, 193 unfair) |
| train, val | LexGLUE `unfair_tos`, converted to one label per sentence, minus every sentence that also appears in the test set | 6,446 and 717 |

LexGLUE labels are multi-label. A sentence with no label is `other`, one label is kept, and several labels go to the rarest. The benchmark set is **used only for testing**: not for training, not for choosing hyper-parameters, not for fitting the temperature (that uses the validation split). Rare classes are small (the test set has 8 arbitration and 13 content-removal sentences), so every number carries a confidence interval and per-class results matter more than the average.

The personal-data question is trained on **synthetic pages**: fake people (Faker) on account, order, profile and message pages, against public policy pages and anonymous pages. Whole page templates are held out for the test split to measure generalisation to page types the model has not seen. 21 real public policy pages are kept as extra negatives (`ml/pii/fetch_real_negatives.py`). This data is more regular than real pages, which makes its scores optimistic: see the caveats in [evaluation.md](evaluation.md).

`ml/data/` holds the generated files and is not in git. `uv run ml/prepare.py` rebuilds the ToS splits; `ml/pii/make_data.py` the personal-data ones.

## Models and training

| Model | Starting point | Recipe |
|---|---|---|
| **Accurate (4B)** | `jaredpalmer/kev-4b`: Qwen3.5-4B-Base plus the Kev LoRA adapter | Continue training the adapter (rank 16, bf16 base, fp32 LoRA) with cross-entropy over the nine letter logits. Defaults of `train.py`: class weights `count^-0.5`, 3 epochs, learning rate 5e-5 |
| **Fast (0.8B)** | Qwen3.5-0.8B-Base, fresh LoRA (rank 64) | The same loss on the hard labels. Distilling from the 4B (`distill_targets.py`, `train.py --teacher`) was tried and added nothing, because the teacher had memorised its own training set, so it is not used |
| Both, second stage | the trained adapter | **Multi-task**: add the personal-data question and keep the ToS skill, with 2,500 replayed ToS examples (`pii/train_pii.py`) |

Kev's own pointer head cannot run in WebLLM, so its LoRA is used with letter scoring instead; a zero-shot Kev scored this way is far below the fine-tuned model (see evaluation). Training ran on one RTX 5060 Ti (16 GB), in bf16 with gradient checkpointing.

**Calibration.** The raw letter probabilities are over-confident, so a single temperature is fitted on the validation split and applied to the test split and in the browser (`calibrate.py`). It is stored per task in `ppg-model.json`. The extension flags a sentence when its most likely class is not `other`.

## Compression and packaging

The browser needs small files, so the merged bf16 model is quantised to 4 bits and packed in the layout WebLLM's prebuilt Qwen3.5 kernels load.

- `merge.py` folds the LoRA into the base weights.
- **Quantisation.** Plain round-to-nearest 4-bit (`q4f32_1`, group size 32) scored as well as bf16 (0.811 against 0.793 macro-F1 on the 4B). A learned method, GSQ, was tried on the MLP layers and scored 0.789, slightly lower (paired difference −0.022), so the shipped weights use plain rounding. A three-bit build is blocked because MLC's compiler fails on this architecture. RCO (per-layer bit allocation) was not run.
- `compress/pack_mlc.py` writes the MLC weight format directly, because `mlc_llm convert_weight` crashes on Qwen3.5 in the current nightly. `compress/unpack_mlc.py` turns a bundle back into bf16 so exactly what ships can be evaluated, and `test_pack.py` checks the packer on CPU.
- `compress/write_meta.py` writes `ppg-model.json` into the bundle: id, tier, version, kernel file, answer-letter token ids, context window (2,048), temperatures and the held-out reports.
- `bun run models:manifest` (repository root) indexes `data/models` into `manifest.json`, which the server serves and the extension reads.

The prebuilt kernels (`Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm`, `Qwen3.5-4B-q4f32_1_cs1k-webgpu.wasm`) come from the WebLLM project and are served as they are. Loading the packed weights under them agreed with the PyTorch reference on every one of 300 test passages (see `spike/webllm/FINDINGS.md`).

## Reproducing it

The Python environments are **not** in git: they are several gigabytes each. Exact package lists are in `ml/env/` (`kev.txt`, `gsq.txt`, `mlc.txt`, from `uv pip freeze`).

```bash
# 1. the environment used for training and evaluation
git clone https://github.com/jaredpalmer/kev ml/vendor/kev && git -C ml/vendor/kev checkout 85ccf56
uv venv ml/vendor/kev/.venv --python 3.13
uv pip install --python ml/vendor/kev/.venv/bin/python -r ml/env/kev.txt \
    --extra-index-url https://download.pytorch.org/whl/cu128

# 2. data
uv run ml/prepare.py                 # ToS splits
uv run ml/pii/make_data.py           # personal-data splits

# 3. train, evaluate, calibrate (run outputs go under PPG_CACHE: see ml/paths.py)
export HF_HOME=/path/to/hf-cache
cd ml
vendor/kev/.venv/bin/python train.py --name run1
vendor/kev/.venv/bin/python eval_letter.py --adapter /path/to/run1/best --name run1-letter
vendor/kev/.venv/bin/python merge.py /path/to/run1/best /path/to/merged
```

The remaining steps (distillation, multi-task training, packing) take the same pattern: each script's docstring names its arguments. The scripts keep run outputs and merged models under `/ironwolf/ppg-cache` (a large disk outside the repository), and write reports to `ml/reports/` (committed, JSON). For the GSQ experiment, clone `https://github.com/IST-DASLab/GSQ` into `ml/vendor/GSQ`, create its environment from `ml/env/gsq.txt` the same way, and run `ml/compress/setup_gsq.sh` to register the ToS calibration set. `ml/env/mlc.txt` lists the MLC nightly toolchain used in the attempts to compile new kernels (wheels from `https://mlc.ai/wheels`); the packer itself does not need it.

## Accuracy work (October 2026): what changed and how to run it

Four changes, all optional and backward compatible: a bundle without the new fields behaves exactly as before.

| # | Change | Files | Status |
|---|---|---|---|
| 1 | **Train both questions in one stage.** The old second stage replayed only 2,500 ToS sentences; on the paired test (`compare.py`) it cost the 4B **0.051** macro-F1 (0.811 → 0.760, 95% CI +0.009 .. +0.094). The 0.8B showed no clear loss (−0.005, CI −0.040 .. +0.031). `train_joint.py` mixes all ToS sentences, all PII pages and (optionally) distillation data every epoch, and keeps the best epoch whose PII val recall stays ≥ 0.95. **Result (`j4b-v1`, RTX 5070 Ti, 1 h 47 min): test macro-F1 0.816 against 0.760 for the shipped 4B (+0.057, paired 95% CI +0.027 .. +0.089)**, level with the old single-task 4B (0.811). Caveat: PII recall on the held-out `stealth_messages` template fell from 63% to 5% (the other 13 personal templates stay at 100%, false alarms fell); val has no such page, so this must be fixed before shipping. | `train_joint.py` | **done, kept** |
| 2 | **Flag threshold on P(other)**, tuned on val with bootstrap smoothing (`tune_threshold.py`), shipped as `tasks.tos.otherThreshold`. Checked on the shipped models' saved logits (tune on half the test set, score the other half, 20 times): an F1-tuned threshold gains **nothing** over argmax (−0.002 / −0.004), so bundles ship **without** one unless `write_meta.py --with-threshold`. What it is good for is the recall dial: `--objective recall:0.9` hit 0.90 recall on unseen sentences, at the cost of false alarms on 10% (0.8B) / 6% (4B) of fair sentences instead of 2.6% / 3.0%. | `tune_threshold.py`, `eval_letter.py`, `calibrate.decide`, `decideCategory` | done; off by default |
| 4 | **Distillation on unlabelled sentences.** Distilling on the training split failed because the teacher had memorised it. Now the teacher labels sentences from real terms pages it has never seen; exact and near-duplicate (word-trigram Jaccard ≥ 0.5) test sentences are removed first. Teacher: step 1's `j4b-v1`; student prompt `letters-v1`; 19,836 unlabelled sentences from 61 real terms pages. **Result (`j08-kd`, about 2 h): test macro-F1 0.800 against 0.769 for the shipped 0.8B (+0.031, paired 95% CI −0.008 .. +0.070, better in 94% of resamples: likely but not proven). PII question much better: recall 1.000 (0 missed, `stealth_messages` included) against 0.976, false alarms 9 against 160.** Joint training and distillation were changed together, so their shares are not separated. **Packed to 4 bits (`ship_model.py`, bundle `ppg-fast-j08-kd-q4f32_1`, 451 MB): macro-F1 0.798, same as unpacked (−0.002, CI −0.012 .. +0.010), +0.029 over the shipped 0.8B. PII after packing: recall still 1.000, but false alarms rose from 9 to 83 (shipped: 160), all on public product pages (50%) and public biographies (19%); a false alarm only means a public page's result is not shared.** | `unlabeled/`, `eval/segment-unlabeled.ts`, `distill_targets.py`, `train_joint.py --unlabeled` | **done, kept** |
| 1b | **PII data v2 and the 4B again (`j4b-v1b`, step `4bfix`).** `j4b-v1` missed the chat-list test page because no training page was a conversation. `pii/make_data.py` now adds private chats and group chats, look-alike public conversations (news comments, a product page's demo chat), and holds out a notification page and a public forum thread for validation only; the test split is byte-identical. **Result: ToS test macro-F1 0.818 (same as `j4b-v1`, +0.058 over the shipped 4B, CI +0.023 .. +0.095); PII test recall 1.000 (`stealth_messages` 5% → 100%), false alarms 16 (shipped 15); validation, including the two unseen templates, recall 1.000 with 0–2 false alarms.** The training pages were designed after seeing the test miss, so `stealth_messages` is no longer a clean held-out measure; the val-only templates are. | `pii/make_data.py`, `run_plan.py --only 4bfix` | **done, kept** |
| 5+6 | **Prompt `letters-v2`**: each option carries its definition, and the previous sentence is shown as context. LexGLUE keeps sentences in reading order and every MTEB test sentence is found in it, so train, val and test all get their real previous sentence (2,047 of 2,048 test sentences have one). Train/val never see a test sentence as context. Training drops the context 30% of the time. The extension passes the previous sentence for v2 models. **Result (`j4b-v2`, 3 h 14 min): test macro-F1 0.810, no better than v1 (−0.007, CI −0.037 .. +0.023); the context alone added nothing (−0.002 against the same model without it). Dropped**: no gain, and a ~3× longer prompt would make the extension ~3× slower. The code stays (bundles declare their prompt version) but no plan step uses it. | `prompt.py`, `prepare.py`, `classifier-prompt.ts`, engine, analyzer | **tried, dropped** |

**Cost of v2.** The prompt is about 3× as many tokens (mean 285 against 93 per test sentence, Qwen tokenizer), so training is about 3× slower and the browser's per-sentence time goes up. Measure the 357-sentence GitHub terms page (about 40 s on the 0.8B with v1) before shipping a v2 bundle. `eval_letter.py --no-context` and the `tos_val_macro_f1_no_context` value `train_joint.py` prints each epoch show what the context alone adds.

### Running it on your own Windows PC (one command)

Tested settings fit a 16 GB card (RTX 5060 Ti / 5070 Ti). Easiest: download `ml/windows/start-training.bat` and double-click it; it fetches this branch into `%USERPROFILE%\ppg-train`, installs what is missing (Python environment, Bun) and runs everything below. By hand, from the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File ml\windows\setup.ps1     # once: makes ml\.venv with PyTorch for CUDA 12.8 and checks the GPU
ml\.venv\Scripts\python.exe ml\run_plan.py                         # steps 1 and 4, in order
```

`run_plan.py` can be stopped (Ctrl+C, a reboot) and started again: finished steps are skipped. `--only 1` runs just step 1;
`--extra "--max_steps 20"` makes a quick smoke test of the whole chain. It logs every step to `ml/logs/`, and writes `ml/reports/plan_summary.md` with the paired comparisons.
Big files go to `%USERPROFILE%\ppg-cache` (set `PPG_CACHE` to put them elsewhere; see `ml/paths.py`), models to the
Hugging Face cache. Expect roughly 25 GB of disk. The new 4B runs are scored unquantised, the shipped `run4bmt` after
4-bit packing; packing cost nothing before (0.793 -> 0.811), but pack and re-score the winner before shipping it.

### Runbook (the same steps by hand)

Every comparison below is against the same test set with `compare.py` (paired bootstrap), not by eyeballing two numbers.

```bash
cd ml; export HF_HOME=/path/to/hf-cache PY=vendor/kev/.venv/bin/python RUNS=~/ppg-cache/runs MERGED=~/ppg-cache/merged   # see ml/paths.py
uv run prepare.py && uv run pii/make_data.py            # re-run: the splits now carry "prev" (same rows as before)

# 1. joint training, old prompt: does the 4B get back to ~0.81?
$PY train_joint.py --name j4b-v1 --base Qwen/Qwen3.5-4B-Base --adapter kev --prompt letters-v1
$PY eval_letter.py --adapter $RUNS/j4b-v1/best --name j4b-v1
python3 compare.py reports/run4bmt-rtn4-deq-letter.json reports/j4b-v1.json     # against the shipped 4B
$PY pii/eval_pii.py --base Qwen/Qwen3.5-4B-Base --adapter $RUNS/j4b-v1/best --name j4b-v1-pii

# 5+6. the same with the v2 prompt (smaller --micro if memory runs out: prompts are 3x longer)
$PY train_joint.py --name j4b-v2 --base Qwen/Qwen3.5-4B-Base --adapter kev --prompt letters-v2 --micro 4 --accum 4
$PY eval_letter.py --adapter $RUNS/j4b-v2/best --prompt letters-v2 --name j4b-v2
$PY eval_letter.py --adapter $RUNS/j4b-v2/best --prompt letters-v2 --no-context --name j4b-v2-noctx
python3 compare.py reports/j4b-v1.json reports/j4b-v2.json

# 4. unlabelled data, teacher logits, 0.8B student
uv run unlabeled/fetch_pages.py && (cd .. && bun run eval/segment-unlabeled.ts) && python3 unlabeled/filter.py
$PY merge.py $RUNS/<best 4B>/best $MERGED/teacher4b
$PY distill_targets.py $MERGED/teacher4b T4 --prompt <the teacher's prompt version>
$PY train_joint.py --name j08-kd --base Qwen/Qwen3.5-0.8B-Base --lora_r 64 --prompt <v1 or v2, whichever won> \
    --unlabeled unlabeled --teacher T4
$PY eval_letter.py --adapter $RUNS/j08-kd/best --base Qwen/Qwen3.5-0.8B-Base --prompt <same> --name j08-kd
python3 compare.py reports/stu08mt-rtn4-deq-letter.json reports/j08-kd.json    # against the shipped 0.8B

# shipping, all in one (merge, pack, unpack + re-test what ships, compare, ppg-model.json, kernel, manifest):
#   python3 ship_model.py                      (fast tier, run j08-kd; Windows: double-click ml\windows\ship-model.bat)
#   python3 ship_model.py --run j4b-v1 --size 4B --tier accurate --replaces run4bmt-rtn4-deq-letter
# or by hand: merge, pack and evaluate the packed weights as before, then
python3 compress/write_meta.py <bundle> ... --tos-report reports/<packed run>.json [--with-threshold]
```

`train_joint.py` writes to `$PPG_RUNS` (default `<PPG_CACHE>/runs`, see `ml/paths.py`). A teacher's logits are only valid for the exact `data/unlabeled.jsonl` they were computed on; re-run `distill_targets.py` after rebuilding it.

## Keeping Python and TypeScript in step

Two things must match exactly between this folder and the extension: the prompts and the text normaliser. After changing `prompt.py`, run `python3 ml/golden_prompts.py`; after changing the normaliser, `uv run ml/golden_text.py`. Both rewrite files under `packages/shared/test/fixtures/`, and `bun test` fails if the TypeScript no longer reproduces them.
