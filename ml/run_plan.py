"""Runs the whole accuracy plan (docs/ml.md, "Accuracy work") on one GPU, in order, and can be stopped and restarted:
a finished step (its report or checkpoint exists) is skipped next time, and an unfinished training run carries on after
its last finished epoch (train_joint.py saves its state at the end of each epoch).

  1    j4b-v1   4B, both questions trained together, old prompt         -> compared with the shipped 4B
  5+6  j4b-v2   4B, both together, prompt with definitions + context    -> compared with j4b-v1
  4    j08-kd   0.8B, both together, plus distillation from the better 4B on unlabelled real terms pages
                                                                         -> compared with the shipped 0.8B

Winners are picked by VALIDATION macro-F1 (each run's best.json), never by the test set; the test set is only scored
and compared. Everything prints to the screen and to ml/logs/<step>.log. At the end: ml/reports/plan_summary.md.

run (Windows):  ml\\.venv\\Scripts\\python.exe ml\\run_plan.py            (Linux: ml/.venv/bin/python ml/run_plan.py)
options:        --only 1,56,4   --skip-fetch (reuse data/unlabeled_pages.jsonl)   --dry (print the commands only)"""
import argparse, json, os, pathlib, shutil, subprocess, sys, time

ML = pathlib.Path(__file__).resolve().parent; ROOT = ML.parent
sys.path.insert(0, str(ML))
from paths import RUNS, MERGED

ap = argparse.ArgumentParser(); ap.add_argument("--only", default="1,56,4"); ap.add_argument("--skip-fetch", action="store_true")
ap.add_argument("--dry", action="store_true"); ap.add_argument("--base4b", default="Qwen/Qwen3.5-4B-Base"); ap.add_argument("--base08", default="Qwen/Qwen3.5-0.8B-Base")
ap.add_argument("--extra", default="", help="extra arguments for every train_joint.py call, e.g. \"--max_steps 20\" for a smoke test")
a = ap.parse_args(); only = set(a.only.split(","))
PY = sys.executable
ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}     # Windows defaults to the local code page otherwise
LOGS = ML / "logs"; LOGS.mkdir(exist_ok=True)
REP = ML / "reports"; DATA = ML / "data"

def run(step, cmd, cwd=ML):
    """Runs one command, streaming its output to the screen and to logs/<step>.log. Stops the plan if it fails."""
    cmd = [str(c) for c in cmd]
    print(f"\n=== {step}: {' '.join(cmd)}", flush=True)
    if a.dry: return
    t0 = time.time()
    with open(LOGS / f"{step}.log", "a", encoding="utf-8") as log:
        log.write(f"\n=== {time.ctime()} {' '.join(cmd)}\n")
        p = subprocess.Popen(cmd, cwd=cwd, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        for line in p.stdout: print(line, end="", flush=True); log.write(line)
        if p.wait(): sys.exit(f"\n*** {step} failed (exit {p.returncode}); see ml/logs/{step}.log. Fix it and run run_plan.py again: finished steps are skipped.")
    print(f"=== {step} done in {(time.time()-t0)/60:.0f} min", flush=True)

def done(path): return pathlib.Path(path).exists() and not a.dry
def val_f1(run_name):
    f = RUNS / run_name / "best.json"
    return json.loads(f.read_text())["tos_val_macro_f1"] if f.exists() else -1
def summary_line(report):
    r = json.loads((REP / f"{report}.json").read_text()); t = r["T"]
    return f"| {report} | {t['macro_f1']:.3f} [{t['ci95']['macro_f1'][0]:.3f}, {t['ci95']['macro_f1'][1]:.3f}] | {t['unfair_f1']:.3f} |"

notes = []
def compare(tag, a_rep, b_rep):
    if a.dry or not (REP / f"{a_rep}.json").exists(): return
    out = subprocess.run([PY, "compare.py", f"reports/{a_rep}.json", f"reports/{b_rep}.json"], cwd=ML, env=ENV, capture_output=True, text=True, encoding="utf-8")
    print(out.stdout); notes.append(f"**{tag}** ({a_rep} → {b_rep})\n```\n{out.stdout.strip()}\n```")

def train(name, *args):
    if done(RUNS / name / "history.json"): print(f"--- {name}: already trained, skipping"); return   # best.json appears after epoch 1
    run(f"train-{name}", [PY, "train_joint.py", "--name", name, *args, *a.extra.split()])
def evaluate(name, base, prompt, *extra, report=None):
    report = report or name
    if done(REP / f"{report}.json"): print(f"--- {report}: already evaluated"); return
    run(f"eval-{report}", [PY, "eval_letter.py", "--adapter", RUNS / name / "best", "--base", base, "--prompt", prompt, "--name", report, *extra])
def eval_pii(name, base):
    if done(REP / f"{name}-pii.json"): return
    run(f"evalpii-{name}", [PY, "pii/eval_pii.py", "--base", base, "--adapter", RUNS / name / "best", "--name", f"{name}-pii"])

# 0. data (the splits must carry "prev"; old ones from before letters-v2 do not)
if not done(DATA / "train.jsonl") or '"prev"' not in (DATA / "train.jsonl").open(encoding="utf-8").readline():
    run("data-tos", [PY, "prepare.py"])
if not done(DATA / "pii_train.jsonl"): run("data-pii", [PY, "pii/make_data.py"])

# 1. both questions in one stage, old prompt
if "1" in only:
    train("j4b-v1", "--base", a.base4b, "--adapter", "kev", "--prompt", "letters-v1")
    evaluate("j4b-v1", a.base4b, "letters-v1"); eval_pii("j4b-v1", a.base4b)
    compare("Step 1: joint training vs the shipped 4B", "run4bmt-rtn4-deq-letter", "j4b-v1")

# 5+6. definitions + previous sentence (prompts are ~3x longer, hence the smaller micro-batch)
if "56" in only:
    train("j4b-v2", "--base", a.base4b, "--adapter", "kev", "--prompt", "letters-v2", "--micro", "4", "--accum", "4")
    evaluate("j4b-v2", a.base4b, "letters-v2"); evaluate("j4b-v2", a.base4b, "letters-v2", "--no-context", report="j4b-v2-noctx")
    eval_pii("j4b-v2", a.base4b)
    compare("Step 5+6: v2 prompt vs v1 prompt (both joint)", "j4b-v1", "j4b-v2")
    compare("Step 5+6: what the previous sentence adds", "j4b-v2-noctx", "j4b-v2")

# 4. distillation into the 0.8B
if "4" in only:
    # the teacher and the student's prompt: whichever 4B run has the better VALIDATION macro-F1
    cands = [(val_f1(n), n, p) for n, p in (("j4b-v1", "letters-v1"), ("j4b-v2", "letters-v2")) if val_f1(n) >= 0]
    if not cands and not a.dry: sys.exit("step 4 needs a trained 4B (step 1 or 5+6) as the teacher")
    _, teacher, tprompt = max(cands) if cands else (0, "j4b-v1", "letters-v1")
    print(f"\n--- teacher: {teacher} ({tprompt}), chosen by validation macro-F1 {dict((n, round(f, 3)) for f, n, _ in cands)}")
    if not a.skip_fetch and not done(DATA / "unlabeled_pages.jsonl"): run("unl-fetch", [PY, "unlabeled/fetch_pages.py"])
    if not done(DATA / "unlabeled.jsonl"):
        bun = shutil.which("bun")
        if not bun and not a.dry: sys.exit("Bun is needed to split the pages with the extension's own splitter: https://bun.sh")
        run("unl-segment", [bun or "bun", "run", "eval/segment-unlabeled.ts"], cwd=ROOT)
        run("unl-filter", [PY, "unlabeled/filter.py"])
    merged = MERGED / f"{teacher}-teacher"
    if not done(merged / "config.json"): run("merge-teacher", [PY, "merge.py", RUNS / teacher / "best", merged, a.base4b])
    tname = f"T-{teacher}"
    if not done(DATA / f"{tname}.unlabeled.logits.npy"): run("distill-targets", [PY, "distill_targets.py", merged, tname, "--prompt", tprompt])
    train("j08-kd", "--base", a.base08, "--lora_r", "64", "--prompt", tprompt, "--unlabeled", "unlabeled", "--teacher", tname)
    evaluate("j08-kd", a.base08, tprompt); eval_pii("j08-kd", a.base08)
    compare("Step 4: distilled 0.8B vs the shipped 0.8B", "stu08mt-rtn4-deq-letter", "j08-kd")

if not a.dry:
    rows = [summary_line(r) for r in ("run4bmt-rtn4-deq-letter", "j4b-v1", "j4b-v2", "j4b-v2-noctx", "stu08mt-rtn4-deq-letter", "j08-kd") if (REP / f"{r}.json").exists()]
    vals = {n: round(val_f1(n), 3) for n in ("j4b-v1", "j4b-v2", "j08-kd") if val_f1(n) >= 0}
    (REP / "plan_summary.md").write_text("# Accuracy plan results\n\nTest macro-F1 (argmax, 95% CI) and flag-or-not F1. Shipped models: run4bmt (4B), stu08mt (0.8B).\n\n"
        "| report | macro-F1 | unfair F1 |\n|---|---|---|\n" + "\n".join(rows) + f"\n\nValidation macro-F1 (used for every choice): {vals}\n\n" + "\n\n".join(notes) + "\n", encoding="utf-8")
    print(f"\nAll done. Summary: {REP / 'plan_summary.md'}")
