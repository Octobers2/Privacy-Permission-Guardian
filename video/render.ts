/**
 * Renders the scenes to video, mixes the narration in and joins everything.
 *
 *   bun run video/render.ts scene s01        render one scene to out/scenes/s01.mp4
 *   bun run video/render.ts still s01 5000   one PNG of scene s01 at 5000 ms (out/stills), to look at a frame
 *   bun run video/render.ts all              every scene
 *   bun run video/render.ts final            join the scene files into out/ppg-demo.mp4 and write out/ppg-demo.srt
 *
 * A scene is never played: for each frame the page's `seek(t)` is called and the page photographed, so a render does not depend on
 * how fast this computer is. Run `bun run video/timeline.ts` first (and again after the voice clips change).
 */
import { chromium, type Page } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { track, wav } from './sfx.ts';
import type { Scene } from './timeline.ts';

const dir = import.meta.dir;
const out = resolve(dir, 'out');
const timeline = JSON.parse(readFileSync(resolve(dir, 'timeline.json'), 'utf8')) as { fps: number; scenes: Scene[]; total: number };
const FPS = timeline.fps;
mkdirSync(resolve(out, 'scenes'), { recursive: true });
mkdirSync(resolve(out, 'stills'), { recursive: true });

async function openScene(scene: Scene): Promise<{ page: Page; close: () => Promise<void> }> {
  const browser = await chromium.launch({
    executablePath: Bun.env.CHROMIUM ?? '/usr/bin/chromium',
    headless: true,
    // small on purpose: this runs next to other work (--disable-gpu: scenes need no GPU; the renderer cap keeps one scene from growing)
    args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--disable-gpu', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=384', '--renderer-process-limit=1'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.addInitScript(({ cues, duration }) => {
    (window as any).__cues = cues;
    (window as any).__duration = duration;
    (window as any).__renderer = true;
  }, { cues: scene.lines.map((l) => ({ start: l.start, end: l.end })), duration: scene.duration });
  page.on('pageerror', (e) => console.error(`  [${scene.id}] page error: ${e.message}`));
  await page.goto(`file://${resolve(dir, 'scenes', scene.id + '.html')}`);
  await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 30_000 });
  return { page, close: () => browser.close() };
}

const sceneOf = (id: string) => {
  const scene = timeline.scenes.find((s) => s.id === id);
  if (!scene) throw new Error(`no scene "${id}" in timeline.json (${timeline.scenes.map((s) => s.id).join(', ')})`);
  return scene;
};

async function still(id: string, ms: number): Promise<string> {
  const { page, close } = await openScene(sceneOf(id));
  await page.evaluate((t) => (window as any).seek(t), ms);
  const path = resolve(out, 'stills', `${id}-${String(ms).padStart(6, '0')}.png`);
  await page.screenshot({ path });
  await close();
  return path;
}

/** The scene's narration as one audio track, clips placed at their start times; silence where there is no clip. */
function audioArgs(scene: Scene, sfxFile: string | null): { inputs: string[]; filter: string } {
  // SILENT=1: picture only (a review cut before the voices exist); the timing still follows the clips
  const clips = Bun.env.SILENT ? [] : scene.lines.filter((l) => l.audio);
  const inputs = ['-f', 'lavfi', '-t', String(scene.duration / 1000), '-i', 'anullsrc=r=48000:cl=mono'];
  for (const c of clips) inputs.push('-i', resolve(dir, c.clip));
  // input 0 is the silent video, 1 the silent base track, 2... the clips
  if (sfxFile) inputs.push('-i', sfxFile);
  const sfxIndex = 2 + clips.length;
  const delayed = clips.map((c, i) => `[${i + 2}:a]aresample=48000,adelay=${c.start}|${c.start}[d${i}]`);
  const mix = `[1:a]${clips.map((_, i) => `[d${i}]`).join('')}${sfxFile ? `[${sfxIndex}:a]` : ''}amix=inputs=${clips.length + 1 + (sfxFile ? 1 : 0)}:normalize=0:duration=first[a]`;
  return { inputs, filter: [...delayed, mix].join(';') };
}

async function renderScene(id: string): Promise<string> {
  const scene = sceneOf(id);
  const frames = Math.round((scene.duration / 1000) * FPS);
  const silent = resolve(out, 'scenes', `${id}.video.mp4`);
  const final = resolve(out, 'scenes', `${id}.mp4`);
  const { page, close } = await openScene(scene);

  // sound effects: the events the scene logged while it was built, synthesized into a track as long as the scene (NOSFX=1 leaves them out)
  let sfxFile: string | null = null;
  if (!Bun.env.NOSFX) {
    const events = await page.evaluate(() => (window as any).__sfx ?? []);
    sfxFile = resolve(out, 'scenes', `${id}.sfx.wav`);
    writeFileSync(sfxFile, wav(track(events, scene.duration, Number(Bun.env.SFX_GAIN ?? (Bun.env.SILENT ? 0.8 : 0.32)))));
    console.log(`  ${id}: ${events.length} sound-effect events`);
  }

  const encoder = Bun.spawn(
    ['ffmpeg', '-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(FPS), silent],
    { stdin: 'pipe', stderr: 'inherit' },
  );
  const started = Date.now();
  // a frame that takes half a minute means the browser died (out of memory next to other work): fail, so the caller can start again
  const within = <T>(p: Promise<T>, what: string) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`${id}: ${what} took over 30 s at frame ${current}`)), 30_000))]);
  let current = 0;
  for (let f = 0; f < frames; f++) {
    current = f;
    await within(page.evaluate((t) => (window as any).seek(t), (f / FPS) * 1000), 'seek');
    encoder.stdin.write(await within(page.screenshot({ type: 'jpeg', quality: 92 }), 'screenshot'));
    if (f % 150 === 0) process.stdout.write(`\r  ${id}: frame ${f}/${frames}  ${(((Date.now() - started) / 1000) / Math.max(f, 1)).toFixed(2)} s/frame   `);
  }
  await encoder.stdin.end();
  await encoder.exited;
  await close();

  const audio = audioArgs(scene, sfxFile);
  const mux = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-i', silent, ...audio.inputs, '-filter_complex', audio.filter, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-shortest', final], { stderr: 'inherit' });
  if (mux.exitCode !== 0) throw new Error(`ffmpeg audio mix failed for ${id}`);
  process.stdout.write(`\r  ${id}: ${frames} frames, ${(scene.duration / 1000).toFixed(1)} s, ${Bun.env.SILENT ? 0 : scene.lines.filter((l) => l.audio).length}/${scene.lines.length} voiced -> ${final}\n`);
  return final;
}

const stamp = (ms: number) => {
  const p = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
  return `${p(ms / 3_600_000)}:${p((ms / 60_000) % 60)}:${p((ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

function joinAll(): void {
  const files = timeline.scenes.map((s) => resolve(out, 'scenes', `${s.id}.mp4`));
  for (const f of files) if (!existsSync(f)) throw new Error(`missing ${f}: render every scene first (bun run video/render.ts all)`);
  const list = resolve(out, 'concat.txt');
  writeFileSync(list, files.map((f) => `file '${f}'`).join('\n') + '\n');
  const joined = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', resolve(out, 'ppg-demo.mp4')], { stderr: 'inherit' });
  if (joined.exitCode !== 0) throw new Error('ffmpeg concat failed');
  let n = 1;
  const srt = timeline.scenes.flatMap((s) => s.lines.map((l) => `${n++}\n${stamp(s.offset + l.start)} --> ${stamp(s.offset + l.end)}\n${l.text}\n`)).join('\n');
  writeFileSync(resolve(out, 'ppg-demo.srt'), srt);
  console.log(`wrote ${resolve(out, 'ppg-demo.mp4')} and ppg-demo.srt (${n - 1} cues)`);
}

const [command, a, b] = process.argv.slice(2);
if (command === 'still') console.log(await still(a!, Number(b ?? 0)));
else if (command === 'scene') await renderScene(a!);
else if (command === 'all') {
  // one process per scene, so a scene's memory is returned when it is done, and a scene that fails is started again
  for (const s of timeline.scenes) {
    for (let attempt = 1; ; attempt++) {
      const child = Bun.spawnSync(['bun', 'run', import.meta.path, 'scene', s.id], { stdout: 'inherit', stderr: 'inherit', env: Bun.env });
      if (child.exitCode === 0) break;
      if (attempt === 4) throw new Error(`${s.id} failed four times`);
      console.log(`\n  ${s.id}: attempt ${attempt} failed, starting again in 20 s`);
      await Bun.sleep(20_000);
    }
  }
}
else if (command === 'final') joinAll();
else console.log('usage: render.ts scene <id> | still <id> <ms> | all | final');
