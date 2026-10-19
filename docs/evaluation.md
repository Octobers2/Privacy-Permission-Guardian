# Evaluation

What was measured, how, and what the numbers do not show. The model training and data are described in [ml.md](ml.md).

Every score for the classifier is on the **MTEB `UnfairTOSLegalBenchClassification` test set: 2,048 sentences, never used for training, choosing settings or fitting calibration.** 1,855 of them are "other"; the 193 unfair ones are spread over eight classes, the smallest with 8 sentences. Reports are JSON files in `ml/reports/`, one per run.

## Clause classifier

Macro-F1 averages the nine classes equally, so a rare class counts as much as "other". "Unfair F1" scores the binary question "is this sentence one of the eight unfair types".

| System | Macro-F1 | Accuracy | Unfair F1 |
|---|---|---|---|
| Kev-4B zero-shot, class names in the prompt | 0.531 | 0.794 | 0.460 |
| Kev-4B zero-shot, class definitions in the prompt | 0.614 | 0.853 | 0.553 |
| Kev adapter with our letter scoring, no further training | 0.378 | 0.469 | 0.264 |
| 4B fine-tuned (bf16) | 0.793 | 0.961 | 0.815 |
| 4B fine-tuned, 4-bit rounding | 0.811 | 0.966 | 0.844 |
| 4B fine-tuned, 4-bit GSQ (MLP layers) | 0.789 | 0.961 | 0.820 |
| 0.8B (bf16) | 0.782 | 0.958 | 0.789 |
| 0.8B, 4-bit rounding | 0.774 | 0.958 | 0.793 |
| **Shipped Accurate (4B), 4-bit, with the personal-data task** | **0.760** | 0.954 | 0.793 |
| **Shipped Fast (0.8B), 4-bit, with the personal-data task** | **0.769** | 0.956 | 0.793 |

Reading this table honestly:

- **The 95% confidence intervals are wide.** For the shipped models the macro-F1 interval is about 0.70 to 0.81 (bootstrap over the test sentences). Differences of a few hundredths between rows are inside it. What the table does show is the large gaps: fine-tuning moves a zero-shot 0.53 to 0.61 up to about 0.8.
- **4-bit rounding cost nothing measurable** (0.793 to 0.811), which is why plain rounding ships. GSQ, a learned quantiser, was slightly worse than rounding on the paired comparison (−0.022).
- **Adding the personal-data task costs some ToS accuracy.** Paired on the same sentences, the 4B lost 0.035 macro-F1 (interval −0.070 to +0.002); the 0.8B lost 0.013, not significant. The shipped 0.8B and 4B are therefore close to each other on this benchmark. The larger model's advantage is on the personal-data question (below).
- **Calibration is good.** Expected calibration error is 0.025 (4B) and 0.015 (0.8B) after the single fitted temperature, so "99% sure" means roughly that.
- **Ordinary web text.** The benchmark's sentences are lower-cased and tokenised. The same 2,048 sentences turned back into ordinary prose and then put through the extension's own normaliser score the same as the original (0.760 for the 4B), and 99.7% of the sentences reproduce exactly. Left un-normalised, the prose scores 0.7725, which is not different within the noise: the model copes with ordinary text, and the normaliser mainly guards against pages that look unlike the training text.

### Per class, shipped models

F1 per class on the test set (support in brackets). The two weakest are the ones with the least data.

| Class | Accurate (4B) | Fast (0.8B) |
|---|---|---|
| Limitation of liability (53) | 0.763 | 0.764 |
| Contract by using (20) | 0.778 | 0.800 |
| Unilateral change (29) | 0.742 | 0.716 |
| **Mandatory arbitration (8)** | **0.522** | 0.615 |
| **Content removal (13)** | **0.562** | 0.667 |
| Choice of law (15) | 0.857 | 0.720 |
| Unilateral termination (38) | 0.779 | 0.767 |
| Jurisdiction (17) | 0.857 | 0.895 |
| Other (1,855) | 0.977 | 0.978 |

Arbitration, one of the clauses people care most about, is the weakest class, and with 8 test sentences its score is very uncertain. The 4B tends to over-flag it (precision 0.40, recall 0.75).

## Personal-data check

Two layers (see [architecture.md](architecture.md)): deterministic rules, and a two-option question to the model.

The model question was tested on 2,016 synthetic pages (1,140 personal, 876 public) in which **whole page templates were held out**, with the threshold fixed at 0.5 and nothing tuned on the test set:

| | Precision | Recall | False alarms | Missed |
|---|---|---|---|---|
| Accurate (4B) | 0.987 | 0.961 | 15 | 44 |
| Fast (0.8B) | 0.874 | 0.976 | 160 | 27 |
| 0.8B base model, no training | 0.58 | 1.00 | 816 of 816 | 0 |

A false alarm means a public page treated as personal, so its result is not shared. A miss means a personal page treated as public, which is the dangerous direction, and is why the rules run first and independently, and why every shared passage is checked again with a stricter rule set on the device and on the server. Public biographies are the known false positives. The rules flagged 0 of 18 real public policy pages, and the model 0%.

**Caveat that matters.** The pages are synthetic: fake people on invented templates. Real account pages are messier, so these scores are almost certainly better than what real use will show. The 21 real pages used as extra negatives (`ml/data/pii_real_negatives.jsonl`) test false alarms only; there is no labelled collection of real personal pages, because collecting one means collecting people's data.

## Whole system

| Measurement | Result | How |
|---|---|---|
| Packed 4-bit weights under WebLLM agree with the PyTorch reference | 300 of 300 test passages give the same answer | `spike/webllm`, `ml/compress` |
| First analysis of a fixture terms page, model load included | about 5 s (0.8B) | `bun run e2e:analysis` |
| The same policy from the public cache | about 0.6 s | same |
| Time per sentence | about 0.1 s (0.8B), about 0.45 s (4B), on an RTX 5060 Ti | spike findings |
| A real long terms page (357 sentences) | about 40 s (0.8B) | `eval/` repro against github.com |
| Content script size | about 33 KB on every page, budget 60 KB | `bun run e2e:banner` |
| Setup wizard downloads and loads each model in a real browser | passes for both tiers | `bun run e2e:setup [--model accurate]` |

On real pages there are no labels, so these runs show that the pipeline works and what gets flagged, not how often it is right. As an illustration, the same GitHub terms page gave 23 flagged sentences from the 0.8B and 28 from the 4B, from 357.

## Form warning

The form warning is rules only (`packages/shared/src/rules.ts` for forms and page-level signals). Its fixtures (`eval/fixtures`, listed in `eval/labels.csv`) are **all synthetic**: written by this project while looking at the rules. On the 14 of them (6 phishing, 8 legitimate) the rules judge every page correctly: all 6 phishing pages reach danger, and no legitimate page does (one, a bank's form that collects name, date of birth and address together, reaches caution). `bun run eval:rules` prints that this does not measure real phishing detection.

Adding the page-level rules did not change the score of any of the original fixtures. That was checked deliberately, because a first version counted a form's destination twice (once as a form that posts elsewhere, once as a page that contacts another host) and pushed every phishing fixture from 80 to 100; a test now locks it. Two legitimate fixtures exist only to show that the new rules do not bite ordinary pages: a normal checkout that collects a card and loads Stripe, a tag manager, analytics and error reporting (25 points, safe), and a photographer's site that blocks right-click, which image sites commonly do (5 points, safe; blocking right-click alone is not treated as hostile).

Which rule is measured where:

| Rule | Measured by |
|---|---|
| bot token, exfiltration destination, developer-tools blocking, right-click blocking, hot-linked icon | `bun run eval:rules` (pure DOM) |
| sensitive fields on a page that contacts unrelated hosts | the static half (addresses written into scripts) in `eval:rules`; real requests only in a browser |
| icon matches a brand the domain does not own | **not measured yet.** The arithmetic is unit-tested on synthetic images, but the brand table ships empty until `bun run favicons` is run with network access, so the full chain has never run |

A hand-written banking login (card PIN, security question) is a known gap: the rules do not yet treat those as sensitive.

## What these numbers do not show

- **Real-world accuracy.** The benchmark is English terms of service from a limited set of services. Other documents, other languages and other styles will differ.
- **Whether a flagged clause is unfair in your jurisdiction, or at all.** The labels are research annotations of clause types, not legal judgements.
- **Rare classes.** Eight arbitration sentences cannot support a firm claim about arbitration.
- **Contributor honesty.** The cache is only as good as the people who upload to it.
- **Usefulness to people.** No user study was run.

## Reproducing

```bash
bun test                                   # unit tests, including the golden-file locks
bun run e2e                                # every browser check
bun run eval:rules                         # form-warning fixtures
vendor/kev/.venv/bin/python ml/eval_letter.py --adapter <dir> --name <report>   # classifier on the test set (see ml.md)
```
