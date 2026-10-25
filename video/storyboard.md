# Storyboard

Style: the team's poster. Matte black `#111`, white, one red `#E1251B`. No gradients or soft shadows. Heavy grotesque type (Archivo Black
for headlines, Archivo for text). Hard rectangles and circles on a modular grid. Things **snap** in (a 6 to 8 frame slide or a 90 degree
rotation, ease-out, then lock) and never fade.

Layout for the feature scenes follows the reference video (ADVIDS "App Demonstration Video"): a large caption column on the left,
the real app in a flat browser frame on the right, a visible cursor, a new step caption every 4 to 6 seconds.

Everything shown of the extension is **real**: a screen recording or screenshot of the built extension in Chromium, from `capture.ts`.
Motion graphics only frame it. 1920 x 1080, 30 fps. Times are targets; the voice sets the final length (`timeline.json`).

| Scene | Target | Narrator | What is on screen |
|---|---|---|---|
| s01 Title | 0:00 to 0:16 | A | Black. "PRIVACY / & / PERMISSION / GUARDIAN" stacked, each word snapping in from a different edge, a red block locking behind the last. The document strip draws itself and a read-head sweeps over it; each flagged clause jumps as it is reached. |
| s02 The hidden cost | 0:16 to 0:59 | A | Five beats, none alike: **1 of 31** with 31 squares, one red; **90% / 58%** as two bars side by side (black half, red half); "WHAT IS HIDING IN THERE?" then three full-screen slabs that each arrive from a different edge; the FTC line typed out; **ACCEPT** being clicked by a cursor. |
| s03 Reading the terms | 0:59 to 2:11 | B | The setup screen with the offline-model promise outlined; the Pomme site kept on the left while the popup works on the right (reading, families, In short, similar cases). Callouts point at the thing being said (one tick = one sentence; five families; In short). Ends on **2,048 / 0.77** counted up and a red bar: "A CLEAN RESULT IS NEVER A GUARANTEE". |
| s04 Real sites, and why not a chatbot | 2:11 to 2:34 | B | GitHub's real terms page being read, with a stopwatch that shows real time while the footage is sped up; then split screen: the team's Gemini recording against ours, labelled "SENT TO A SERVER" and "STAYS IN YOUR BROWSER". |
| s05 Phishing and missing terms | 2:34 to 3:35 | B | "THE SECOND PROBLEM" with three cards dealt as the threats are named (fake logo, form that leaks, blocked devtools); the lookalike sign-in with a ring on the borrowed icon and callouts on the destination and the banner (CRITICAL RISK); a genuine checkout with CAUTION; QuickLoan: the banner, the model reading the page, the Report button, the public list; and a red slab: NO MODEL. NO SERVER. FROM DAY ONE. |
| s06 The loop | 3:35 to 4:22 | C | A loop of five blocks drawn as the voice goes, with a red packet travelling round it. The real "Share this result?" card, held while it is explained and outlined; then the public query site, with the shared-results-only mode named where it is said; "0.6 s" for the next visitor. |
| s07 What comes next | 4:22 to 4:35 | C | A phone beside the browser (MOBILE), a growing stack of documents (LONGER TERMS), then the end card. |

Times are estimates at a deliberate narration pace; the real clips set the final lengths.

## Real footage needed (made by `video/capture.ts`)

1. Setup welcome and model-step screens, and the download bar (Fast, 0.8B).
2. Pomme: home page, terms link, popup reading live (30 fps screencast), the final popup, scrolled to each family.
3. "Find similar cases" and the "Seen on" expansion (needs a second site with a similar clause in the demo database).
4. One real long terms page, live, with timing: GitHub's terms (358 sentences, 82 s on the 0.8B on this computer), shown sped up with a real-time stopwatch and a "sped up" label. Adobe's terms page was tried and could not be read (its text is built by scripts), so it is not in the video.
5. The lookalike sign-in page (`account-verify-center.top`) with the banner; a legitimate checkout (`shop.example.com`) with a caution; QuickLoan.
6. "Share this result?" card, and the query site.
7. The team's Gemini screen recording of the same Pomme terms (their part).
