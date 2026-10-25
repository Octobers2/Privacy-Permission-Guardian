"""
Narration audio, one clip per line of video/narration.md, voiced by Chatterbox on this computer's GPU.

    video/tts/.venv/bin/python video/tts/voice.py                 # every missing clip
    video/tts/.venv/bin/python video/tts/voice.py --scene s04     # one scene
    video/tts/.venv/bin/python video/tts/voice.py --force         # redo clips that exist
    video/tts/.venv/bin/python video/tts/voice.py --list          # show who says what, and which voice file each uses

Each narrator (A, B, C in narration.md) is cloned from a short recording of their voice: video/voices/a.wav, b.wav, c.wav
(15 to 30 seconds of clear, natural speech, one person, a quiet room). A narrator with no file yet gets the model's default voice, so the
whole video can be timed and cut before the real voices exist; run again with --force once the files are there.
Nothing is sent anywhere: the model and the voice samples stay on this machine. Voice samples are personal data: voices/ is gitignored.

Tuning (video/voices/config.json, optional): {"A": {"exaggeration": 0.5, "cfg_weight": 0.5}, ...}
  exaggeration: higher is more expressive; cfg_weight: lower is slower and more deliberate.
After voicing, run `bun run video/timeline.ts` so the scenes are timed to the real clip lengths.
"""
import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VIDEO = HERE.parent


def parse_narration():
    text = (VIDEO / "narration.md").read_text(encoding="utf-8")
    measured = {}
    m = VIDEO / "data" / "measured.json"
    if m.exists():
        measured = json.loads(m.read_text())
    scenes = []
    for block in re.split(r"\n### ", text)[1:]:
        head, *rest = block.strip().split("\n")
        scene_id, narrator, title = [s.strip() for s in head.split("·")]
        lines = []
        for raw in rest:
            raw = raw.strip()
            if not raw:
                continue
            raw = re.sub(r"\s*\(verify\)\s*$", "", raw)
            raw = re.sub(r"\{\{(\w+)\}\}", lambda g: measured.get(g.group(1), "forty"), raw)
            lines.append(raw)
        scenes.append({"id": scene_id, "narrator": narrator, "title": title, "lines": lines})
    return scenes


def save_wav(path, wav, sample_rate):
    """16-bit mono WAV with the standard library: torchaudio's own writer now needs another package."""
    import wave

    import numpy as np

    samples = wav.squeeze().detach().cpu().numpy()
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(pcm.tobytes())


def speakable(line: str) -> str:
    """What the model should say: symbols spelled out, so it does not guess."""
    return line.replace("&", "and").replace("≠", "is not").replace("×", "times").replace("  ", " ")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    scenes = [s for s in parse_narration() if not args.scene or s["id"] == args.scene]
    config_path = VIDEO / "voices" / "config.json"
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    voice_file = lambda n: VIDEO / "voices" / f"{n.lower()}.wav"

    if args.list:
        for s in scenes:
            have = voice_file(s["narrator"]).exists()
            print(f'{s["id"]}  {s["narrator"]}  {"cloned from " + voice_file(s["narrator"]).name if have else "DEFAULT VOICE (no sample yet)"}  {len(s["lines"])} lines')
        return

    import torch
    from chatterbox.tts import ChatterboxTTS

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"loading Chatterbox on {device}")
    model = ChatterboxTTS.from_pretrained(device=device)

    done = 0
    for s in scenes:
        out_dir = VIDEO / "audio" / s["id"]
        out_dir.mkdir(parents=True, exist_ok=True)
        prompt = voice_file(s["narrator"])
        opts = {"exaggeration": 0.5, "cfg_weight": 0.5, **config.get(s["narrator"], {})}
        for i, line in enumerate(s["lines"]):
            target = out_dir / f"{i:02d}.wav"
            said = target.with_suffix(".txt")  # the sentence this clip was made from: an edited line must be voiced again
            if target.exists() and said.exists() and said.read_text(encoding="utf-8") == line and not args.force:
                continue
            wav = model.generate(speakable(line), audio_prompt_path=str(prompt) if prompt.exists() else None, **opts)
            save_wav(target, wav, model.sr)
            said.write_text(line, encoding="utf-8")
            done += 1
            print(f'  {s["id"]} {s["narrator"]} {i:02d}  {wav.shape[-1] / model.sr:5.1f}s  {line[:70]}')
    print(f"{done} clips written to {VIDEO / 'audio'}")


if __name__ == "__main__":
    sys.exit(main())
