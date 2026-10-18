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

# 3. train, evaluate, calibrate (the cache paths inside the scripts point at /ironwolf/ppg-cache; change them to suit)
export HF_HOME=/path/to/hf-cache
cd ml
vendor/kev/.venv/bin/python train.py --name run1
vendor/kev/.venv/bin/python eval_letter.py --adapter /path/to/run1/best --name run1-letter
vendor/kev/.venv/bin/python merge.py /path/to/run1/best /path/to/merged
```

The remaining steps (distillation, multi-task training, packing) take the same pattern: each script's docstring names its arguments. The scripts keep run outputs and merged models under `/ironwolf/ppg-cache` (a large disk outside the repository), and write reports to `ml/reports/` (committed, JSON). For the GSQ experiment, `ml/compress/setup_gsq.sh` registers the ToS calibration set in a GSQ checkout (`https://github.com/IST-DASLab/GSQ`).

## Keeping Python and TypeScript in step

Two things must match exactly between this folder and the extension: the prompts and the text normaliser. After changing `prompt.py`, run `python3 ml/golden_prompts.py`; after changing the normaliser, `uv run ml/golden_text.py`. Both rewrite files under `packages/shared/test/fixtures/`, and `bun test` fails if the TypeScript no longer reproduces them.
