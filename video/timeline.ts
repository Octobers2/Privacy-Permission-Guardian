/**
 * Builds timeline.json: when every narration line starts and ends, and how long every scene is.
 *
 *   bun run video/timeline.ts
 *
 * A line's length is that of its audio clip (audio/<scene>/<nn>.wav, from tts/voice.py) when there is one, and an estimate from its
 * word count when there is not, so the whole pipeline can run before any voice exists. A scene is as long as its narration plus
 * padding, but never shorter than its minimum in scenes.json: the demo parts need room to breathe.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = import.meta.dir;
const cfg = JSON.parse(readFileSync(resolve(dir, 'scenes.json'), 'utf8')) as {
  leadMs: number; lineGapMs: number; tailMs: number; wordsPerSecond: number; minSeconds: Record<string, number>;
};
const measured = existsSync(resolve(dir, 'data/measured.json')) ? (JSON.parse(readFileSync(resolve(dir, 'data/measured.json'), 'utf8')) as Record<string, string>) : {};
const fill = (text: string) => text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => measured[k] ?? 'forty');

export interface Line { text: string; clip: string; audio: boolean; start: number; end: number }
export interface Scene { id: string; narrator: 'A' | 'B' | 'C'; title: string; lines: Line[]; duration: number; offset: number }

function wavSeconds(path: string): number {
  const out = Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { stdout: 'pipe' });
  return Number(new TextDecoder().decode(out.stdout).trim());
}

/** 60 fps by default: the scenes are seeked to an exact time per frame, so motion is as smooth as the frame rate allows. FPS=30 for a lighter render. */
const FPS = Number(Bun.env.FPS ?? 60);

export function build(): { fps: number; scenes: Scene[]; total: number } {
  const blocks = readFileSync(resolve(dir, 'narration.md'), 'utf8').split(/\n### /).slice(1);
  let offset = 0;
  const scenes = blocks.map((block): Scene => {
    const [head, ...rest] = block.trim().split('\n');
    const [id, narrator, title] = head!.split('·').map((s) => s.trim()) as [string, 'A' | 'B' | 'C', string];
    let t = cfg.leadMs;
    const lines = rest
      .map((l) => l.trim())
      .filter(Boolean)
      .map((raw, i): Line => {
        const text = fill(raw.replace(/\s*\(verify\)\s*$/, ''));
        const clip = `audio/${id}/${String(i).padStart(2, '0')}.wav`;
        // ESTIMATE=1 ignores any clip on disk: while the narration is being edited, the clips are for the old text
        // a clip counts only if it was made from this very sentence (voice.py leaves a .txt beside it)
        const said = resolve(dir, clip.replace(/\.wav$/, '.txt'));
        const have = !Bun.env.ESTIMATE && existsSync(resolve(dir, clip)) && existsSync(said) && readFileSync(said, 'utf8') === text;
        const seconds = have ? wavSeconds(resolve(dir, clip)) : text.split(/\s+/).length / cfg.wordsPerSecond + 0.15;
        const line = { text, clip, audio: have, start: Math.round(t), end: Math.round(t + seconds * 1000) };
        t = line.end + cfg.lineGapMs;
        return line;
      });
    const spoken = (lines.at(-1)?.end ?? 0) + cfg.tailMs;
    const duration = Math.max(spoken, (cfg.minSeconds[id] ?? 0) * 1000);
    const scene = { id, narrator, title, lines, duration, offset };
    offset += duration;
    return scene;
  });
  return { fps: FPS, scenes, total: offset };
}

if (import.meta.main) {
  const timeline = build();
  writeFileSync(resolve(dir, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');
  const m = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`;
  for (const s of timeline.scenes) console.log(`${s.id} ${s.narrator}  ${m(s.offset)}  ${(s.duration / 1000).toFixed(1).padStart(5)} s  ${s.lines.filter((l) => l.audio).length}/${s.lines.length} clips  ${s.title}`);
  console.log(`total ${m(timeline.total)}  (${timeline.scenes.flatMap((s) => s.lines).filter((l) => l.audio).length} voiced lines)`);
}
