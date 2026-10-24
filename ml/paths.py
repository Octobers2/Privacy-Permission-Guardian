"""Where big files live, on any machine.

PPG_CACHE   root for run outputs and merged models. Default: /ironwolf/ppg-cache if it exists (the original training
            box), otherwise ~/ppg-cache (e.g. C:\\Users\\<you>\\ppg-cache on Windows).
PPG_RUNS    training runs (default <PPG_CACHE>/runs).
Model downloads go wherever Hugging Face puts them (HF_HOME, default ~/.cache/huggingface)."""
import glob, os, pathlib

_old = pathlib.Path("/ironwolf/ppg-cache")
CACHE = pathlib.Path(os.environ.get("PPG_CACHE") or (_old if _old.exists() else pathlib.Path.home() / "ppg-cache"))
RUNS = pathlib.Path(os.environ.get("PPG_RUNS") or CACHE / "runs")
MERGED = CACHE / "merged"

def kev_adapter() -> str:
    """Local folder of the Kev LoRA (jaredpalmer/kev-4b): the copy on the old box, else the HF cache, else download it."""
    for pattern in ("/ironwolf/ppg-cache/hf/hub/models--jaredpalmer--kev-4b/snapshots/*",):
        found = glob.glob(pattern)
        if found: return found[0]
    from huggingface_hub import snapshot_download
    return snapshot_download("jaredpalmer/kev-4b")
