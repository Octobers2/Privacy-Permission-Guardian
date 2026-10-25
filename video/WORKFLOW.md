# How the demo video is made

This is the whole process, written so the team can review the plan after the first cut and change any step. Everything is in `video/`;
nothing here needs the internet except the one optional live-site clip and the one-time install of the voice tool.

## The idea in one paragraph

The footage is **real**: a script drives the built extension in Chromium against fixture sites and a throwaway server, and records
what happens. The motion graphics (title, statistics, captions, diagrams, end card) are web pages in the team's poster style, and a
renderer photographs them frame by frame. The narration is a text file; each line is turned into audio by a voice-cloning model running on
this computer, and the length of that audio decides when each caption and screen change happens. So changing a sentence changes the
timing of the whole video automatically.

```
 narration.md ──► tts/voice.py ──► audio/<scene>/<nn>.wav ──┐
      │                                                       ▼
      └──────────► timeline.ts ──► timeline.json ──► render.ts ──► out/scenes/*.mp4 ──► out/ppg-demo.mp4 + .srt
 capture.ts ──► footage/*.mp4 + marks.js ──► (scenes/*.html use them)
 stats.ts ──► data/survey.js ──► (scenes/s02.html)
```

## What is where

| Path | What it is | In git? |
|---|---|---|
| `narration.md` | The spoken script. One `###` block per scene, one line per sentence, narrators A / B / C | yes |
| `storyboard.md` | What is on screen in each scene, and the footage list | yes |
| `scenes.json` | Minimum length of each scene, padding between lines | yes |
| `scenes/s01.html` … `s08.html`, `lib.css`, `lib.js` | The scenes and their shared look and runtime | yes |
| `capture.ts`, `seed.ts` | Records the real footage; the invented database it records against | yes |
| `stats.ts` | Computes the survey numbers from the team's spreadsheet | yes |
| `timeline.ts`, `render.ts` | Builds the timing; renders scenes, mixes audio, joins, writes subtitles | yes |
| `tts/voice.py`, `tts/requirements.txt`, `tts/overrides.txt` | Voice cloning (Chatterbox) | yes |
| `data/survey.json`, `data/survey.js`, `data/measured.json` | Survey aggregates (no individual answers); times measured while recording | yes |
| `assets/fonts/` | Archivo and Archivo Black (SIL Open Font Licence) | yes |
| `footage/` | Recorded clips and `marks.json` | no (regenerate with `capture.ts`) |
| `voices/` | The team's voice samples | **no, never commit** |
| `audio/` | Generated narration clips | no |
| `out/` | Rendered scenes, the final MP4, the SRT, review stills | no |
| `timeline.json` | Generated timing | no |

## Steps, in order

Everything runs from the repository root. The extension and the model bundles (`data/models`) must exist first: `bun install`,
`bun run build`.

### 1. Numbers: `bun run video/stats.ts "/path/to/PPG Documents.zip"`

Reads the survey spreadsheet inside the zip and writes only totals. The video quotes: 31 responses, 1 reads terms in full, 90% skip
because they are too long, 58% accept anyway because they feel they have no choice. The script's document says "over 56%"; the
spreadsheet says 58%, so the video says "more than half". The number of people who do not read them in full is 30 of 31.

### 2. Footage: `bun run video/capture.ts all`

Starts a throwaway results server on port 8799 with an invented database (`seed.ts`), starts the fixture sites, launches Chromium with the
extension and records, with a visible arrow and human pauses:

| Clip | What it shows |
|---|---|
| `setup` | The setup wizard, a real model download, the self-test, sign-in |
| `pomme` | The fictional Pomme site (served as `www.pomme-demo.com`) |
| `popup-read` | The popup reading Pomme's terms: the strip filling, the families, "In short", the quotes, "Find similar cases" |
| `popup-share` | The "Share this result?" card, and pressing Share |
| `site-pomme`, `site-home` | The public query site: the shared result, and the "reported as having no terms" list |
| `phish` | A page that borrows a well-known service's icon: the "Critical risk" banner and its reasons |
| `bank` | A genuine-looking shop checkout asking for a card number: "Caution" (the Northvale bank fixture earns Critical risk, so it is not used for this) |
| `quickloan-page`, `quickloan-popup`, `quickloan-banner` | A page that asks for a card and publishes no terms: the warning, the model reading the page, the Report button |

Each clip is written with `marks.json`: the second, within the clip, at which each named thing happens (for example `ready`, `in-short`,
`similar-open`). A scene lines a mark up with a narration cue, and speeds the clip up to fit when it has to; a sped-up passage always
carries a "SPED UP ×N" label, and the stopwatch in the live-site scene shows real time.

The live-site clip is separate because it needs the network and is not repeatable to the second:
`bun run video/capture.ts real:https://github.com/site/terms`. It writes the measured time into `data/measured.json`, which the
narration quotes. **A real run on this computer took 82 seconds for 358 sentences with the 0.8B model.**

Adobe was tried and dropped: its terms page is built by scripts the extension cannot read (one sentence came back), so the video says
nothing it cannot show.

### 3. Voice

Install once (a few gigabytes; the newer PyTorch is needed for this graphics card, see `tts/requirements.txt`):

```bash
uv venv video/tts/.venv --python 3.11
uv pip install --python video/tts/.venv/bin/python --override video/tts/overrides.txt \
    --index-strategy unsafe-best-match --index-url https://download.pytorch.org/whl/cu128 \
    --extra-index-url https://pypi.org/simple -r video/tts/requirements.txt
```

Edited narration lines are voiced again (each clip is stored with the sentence it was made from, and a clip whose sentence changed is ignored). Put each narrator's sample in `video/voices/a.wav`, `b.wav`, `c.wav` (A: the problem; B: the features and demos; C: the loop and what
comes next). 15 to 30 seconds each, one person, quiet room, natural reading pace, no music. Then:

```bash
video/tts/.venv/bin/python video/tts/voice.py --list     # who is cloned, who still has the default voice
video/tts/.venv/bin/python video/tts/voice.py            # makes audio/<scene>/<nn>.wav for every line
```

Until a sample exists that narrator gets the model's default voice, so the first cut can be timed and reviewed; run with `--force` when
the samples arrive. To tune delivery, add `video/voices/config.json`, for example `{"B": {"exaggeration": 0.6, "cfg_weight": 0.4}}`.

### 4. Timing: `bun run video/timeline.ts`

Measures every audio clip (or estimates from word count if there is none yet), places every line, and sets every scene's length as the
longer of its narration and its minimum in `scenes.json` (the demo scenes need room to be seen). Prints the total. Run it again after
any change to the narration or the audio.

### 5. Render: `bun run video/render.ts all`, then `bun run video/render.ts final`

Each scene is a web page. For every frame the renderer asks the page to show time *t* and photographs it, so a render does not depend on
how fast the computer is. About 16,500 frames in all at 60 fps (`FPS=30` for a lighter render; the recorded footage itself is 30 fps and its frames are repeated). `final` joins the scenes into `out/ppg-demo.mp4` (1920 × 1080, 60 fps, H.264,
AAC) and writes `out/ppg-demo.srt` from the narration lines and their timing. The per-scene files stay in `out/scenes/`.

To look at one moment without rendering a scene: `bun run video/render.ts still s04 30000` (scene, milliseconds) writes a PNG to
`out/stills/`. To watch a scene move in a browser while editing it, open `video/scenes/s04.html` directly: it plays in real time, and
`?grid=1` draws the layout grid.

## Revision 2: why the first cut was cut down

The first cut was 6:45 and repeated itself, for three reasons that are worth checking for in any later edit:

1. **Padding.** Each scene had a minimum length (to reach seven minutes), but the narration filled only about four, so 160 of 405
   seconds were scenes sitting on their last frame. There are no minimum lengths now: a scene lasts as long as its narration plus one
   second, and its footage is sped up (and labelled) to fit.
2. **Said twice, shown twice.** The threats were introduced in one scene and explained in another, the share card appeared in two,
   and the statistics were restated in captions. Each idea is now said once and shown once; scenes 3 and 6 merged away.
3. **One motion for everything.** Every caption slid in from the left the same way. `lib.js` now has five (`slide`, `stamp`, `words`,
   `band`, `type`) and a rule of thumb: no two neighbouring captions use the same one. Static footage gets callouts that point at what
   the voice is naming (`callout()`), and the title and loop diagram have motion that means something (a read-head, a packet).

`ffmpeg ... -vf freezedetect=n=-55dB:d=3` lists the stretches where nothing on screen changes for 3 seconds or more; it is the quickest
way to find the next dead spot after an edit. A stretch that is a held thought is fine; a long one is a sentence that needs another beat.

## The look

From the poster: matte black `#111`, white, one red `#E1251B`; heavy grotesque type (Archivo Black for headlines, Archivo for the
rest); hard rectangles and circles on a grid; no gradients, no soft shadows, no fades. Elements **snap** (a fast slide that stops
hard), wipe in like a block of colour, or cut. The structure of the feature scenes follows the reference video: a large caption on the
left, the app on the right, a new caption every few seconds.

The colours of the real extension (the five clause families) appear only inside the recorded footage. The poster's Canva file needs a
login and could not be read, so the style comes from the team's written description of it; if the poster differs, the palette and fonts
are the first lines of `scenes/lib.css`.

## What is honest about it, and what is not

- Every extension screen is a recording of the built extension doing the thing. Where a number appears (survey percentages, seconds,
  sentence counts) it is computed or measured by a script in this folder.
- The sites are fictional fixtures, and Pomme appears as `www.pomme-demo.com` because the results server only stores addresses on
  public domains. The "other sites" it is compared with are an invented database (`seed.ts`) and the video says nothing that suggests
  they are real companies.
- The Google-style icon on the phishing page is Google's real public icon, used the way a phishing page would use it: it is the thing
  being imitated. The page text names no brand.
- Narration lines marked `(verify)` state something about the world outside this repository. **The FTC / Adobe sentence needs checking
  by the team before publishing**: it describes a 2024 lawsuit and should be worded as an allegation, as it is now.
- The "Money" family and the "In short" summary are fixed patterns and fixed wording, not the model, and the video says so on screen.
- Reading a 358-sentence page took 82 seconds on this computer. The video shows the time passing on a stopwatch and sped-up footage,
  labelled.

## Inputs still needed from the team

1. `video/voices/a.wav`, `b.wav`, `c.wav`: one voice sample each (3 to 5 above).
2. `video/footage/gemini.mp4`: a screen recording of Gemini given the same Pomme terms (`eval/fixtures/sites/www.pomme.example/terms.html`;
   paste its text) with the prompt "Summarise the unfair clauses in these terms of service". Scene 5 shows it beside the extension. Until it
   exists the scene shows a "FOOTAGE MISSING" slate in its place.
3. The poster as an image (`video/assets/poster.png`), if the look should be checked against it.
4. A read of `narration.md` and `storyboard.md`.

## Reviewing the first cut: questions worth asking

- Length: the revised cut is about 4:35 at an estimated narration pace. If a longer video is wanted, add *content* (a second real site read
  in full, the 4B model, the settings page), not padding: `scenes.json` can still set a minimum, but the first cut shows what that does.
- Is anything claimed that the footage does not show? (Search `narration.md` for each claim and find the clip.)
- Do the captions say the same thing as the voice, or do they add to it?
- Should the stopwatch scene show the 4B model too? It is slower and more accurate; the footage uses the 0.8B only.
- Subtitles: `out/ppg-demo.srt` has one cue per sentence, which is long on screen for the longest sentences; split them if a venue needs it.

## Changing things

| To change | Edit | Then run |
|---|---|---|
| A sentence | `narration.md` | `voice.py`, `timeline.ts`, `render.ts all`, `final` |
| What a scene shows | `scenes/sNN.html` | `render.ts scene sNN`, `final` |
| How long a scene is | `scenes.json` | `timeline.ts`, `render.ts all`, `final` |
| What the extension looked like | the extension | `bun run build`, `capture.ts <clip>`, then the scenes that use it |
| The survey numbers | the spreadsheet | `stats.ts`, `render.ts scene s02` |
| A voice | `voices/x.wav` | `voice.py --force`, `timeline.ts`, `render.ts all` |
