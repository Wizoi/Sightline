<p align="center">
  <img src="public/logo.svg" width="120" alt="Sightline logo" />
</p>

<h1 align="center">Sightline</h1>

<p align="center"><em>Turn the pages of your sheet music with your eyes — so both hands stay on your instrument.</em></p>

<p align="center">
  ✔ Runs entirely in your browser &nbsp;·&nbsp; ✔ Nothing uploaded &nbsp;·&nbsp; ✔ No account &nbsp;·&nbsp; ✔ Free to host
</p>

---

Sightline watches where you're looking through your webcam and gently scrolls your
score so the music you're reading stays in a comfortable band on the screen. When
you reach the end of a line — or glance down at the next one — it turns the page for
you. No pedals to tap, no hands off the instrument.

> **Tip:** add a short screen-recording or GIF of it in action here — it's the fastest way to show what Sightline does.

## Contents

- [Try it](#try-it)
- [Quick start](#quick-start)
- [Your privacy](#your-privacy)
- [Using Sightline](#using-sightline)
- [Tuning](#tuning)
- [Getting the best accuracy](#getting-the-best-accuracy)
- [Troubleshooting](#troubleshooting)
- [Under the hood](#under-the-hood)
- [Requirements](#requirements)
- [Development](#development)
- [Host your own copy](#host-your-own-copy)
- [Credits & license](#credits--license)

## Try it

**Online (nothing to download):** Sightline is hosted for free on GitHub Pages at
**<https://wizoi.github.io/Sightline/>** — just open that link in Chrome or Edge on a
computer with a webcam. That's the recommended way to use it; no install, no build step,
nothing to keep up to date yourself.

Want to run your own copy or work on the code? See [Development](#development) and
[Host your own copy](#host-your-own-copy).

## Quick start

1. **Load your music** — click *Load PDF* and choose any PDF of your score or part.
2. **Start the camera** — click *Start camera* and allow access when your browser asks.
3. **Calibrate** — nine dots appear; look at each one and click it, holding your gaze until it turns green. Do this sitting the way you'll actually play.
4. **Follow eyes** — click it (or press <kbd>Space</kbd>) and the page starts following you.
5. **Play!** Read normally; when you reach the end of a line or look at the next system, the page advances.

Calibration is saved, so next time you can skip straight to loading your music.

## Your privacy

**Everything happens on your own computer, inside your browser.** Your camera feed is used
only to work out where you're looking, moment to moment — it is never recorded, saved, or
sent anywhere. There is no account, no server, and no upload. Close the tab and nothing is
kept except your saved settings (which live only in your browser).

## Using Sightline

**Tracking type** (in Setup) picks how Sightline reads your intent to turn the page:
- **Wink tracking** (default) — no calibration needed. Wink your **left** eye to scroll up, your **right** eye to scroll down; a *blink* (both eyes together) is ignored, only a one-eyed wink counts. **Wink scroll strength** controls how firm a push each wink gives.
- **Iris tracking** — watches where your eyes point, via the 9-point calibration described above.

Switching tracking types is instant — pick whichever is more reliable for your face/lighting/glasses.

**The reading band** is the horizontal stripe where your current line sits (shown by default).
You choose where it sits on screen and how tall it is. You read within it; the page moves to
keep the music there.

**Turning the page** happens two ways, whichever feels natural: read to the **right edge** of
the band (you've finished the line), or simply **look down** at the next system. A brief hold
prevents accidental turns from a quick glance.

**Snap to systems** (optional) makes the page jump so a whole *system* (a full line of music —
including multi-instrument groups in a full score) lands centered in the band, instead of
scrolling by raw pixels. Turn on *Show detected systems* to see what it found.

**Pause instantly** with the spacebar — or with a **foot pedal**. A Bluetooth page-turner pedal
usually sends a mouse click, and a click anywhere on the music toggles pause. Handy for the
moments you look away and don't want the page to move.

**Recenter** (the <kbd>R</kbd> key or the button) pops a target in the middle of the band; look
at it for a second and tracking snaps back into alignment. **Drift** correction slowly keeps
you centered over a long sitting.

**Presets** let you save a whole setup (speed, band size, everything) per piece — a fast étude
and a slow ballad can each have their own feel.

## Tuning

Every player, webcam, and room is a little different, so a minute with these sliders pays off.
They're grouped into **the reading band** and **how it scrolls**.

| Slider | What it does | Turn it… |
|---|---|---|
| **Reading zone size** | Height of the band you read in | Up if it turns while you're still on a line; down to advance sooner |
| **Where you read on screen** | Band position, top ↔ middle | Toward the top for more look-ahead of what's coming |
| **Turn the page when my eyes reach…** | How far right before it advances | Left to turn earlier; right to require the very end of the line |
| **Page scroll speed** | How fast it moves | Up for quick page turns, down for slow passages |
| **Motion smoothness** | Steady vs. responsive | Up if it jitters; down if it lags your eyes |
| **Wait before turning** | Delay before a turn commits | Up to ignore more stray glances; down for snappier turns |
| **Music size** | Zoom of the score (100% = fit width) | Down to see more of the page at once; up to enlarge |

## Getting the best accuracy

Webcam eye-tracking isn't laser-precise, but a good setup makes it reliable:

- **Light your face** evenly (a lamp in front beats a bright window behind you).
- Put the **camera near eye level** and sit roughly **centered** in its view.
- Leave **Auto-frame** on — it zooms in on your face automatically so your eyes are well-resolved even if you sit back from the laptop.
- Use **Check accuracy** (in Setup): it shows you 7 targets and reports how close your gaze lands, whether up/down or sideways is weaker, and your room brightness — with specific fixes. Aim for "you'd land on the right line" being high.
- If it drifts mid-piece, tap <kbd>R</kbd> to recenter; if your setup changes (new camera, resized window), it'll suggest a quick recalibration.

## Troubleshooting

**The camera won't turn on.** Allow camera access when prompted. Camera access requires a
secure context (HTTPS or `localhost`) — the hosted GitHub Pages link and `npm run dev` /
`npm run preview` both satisfy that automatically.

**It keeps scrolling when I look away.** That's tracking drift. Add light, tap <kbd>R</kbd> to
recenter, or recalibrate — and use the pedal/spacebar pause when you glance away. Running
*Check accuracy* will tell you what's off.

**Snap won't advance.** Make sure a PDF is loaded and *Snap* is on; look down at the next
system and hold briefly. If your score has unusual spacing, turn on *Show detected systems* to
see whether it grouped the staves correctly.

**It feels inaccurate.** Recalibrate slowly (hold your gaze on each dot), improve lighting, and
keep *Head-pose comp* on so moving your head doesn't throw it off.

## Under the hood

<details>
<summary>Gaze tracking</summary>

Sightline uses Google's MediaPipe face-landmark model to locate your eyes and irises in the
webcam image. Rather than using raw iris position (which changes when you move your head), it
reconstructs where your eyes point **relative to your head** from the 3D face geometry, so
calibration survives you swaying and turning while you play. Blinks are detected and ignored.
</details>

<details>
<summary>Calibration</summary>

The nine calibration points fit a small **quadratic model** (plus the model's own eye-look
signals) mapping your eye direction to a point on screen, with feature standardization and
ridge regression so it stays stable and doesn't over-fit. The result is saved locally and
restored automatically; it's re-validated if your camera or window size changes.
</details>

<details>
<summary>Snap: detecting musical systems</summary>

For Snap mode, Sightline renders each page and finds the **staff lines** (long horizontal
strokes), clusters them into staves, then groups staves into systems — accepting the grouping
only when it's consistent. That's why a four-staff clarinet-quartet score snaps by whole
system, while a single-staff part snaps line by line.
</details>

<details>
<summary>Camera zoom</summary>

Auto-frame crops and upscales the view around your face before detection so your eyes get more
pixels when you sit back — it follows your face and periodically widens to the full frame to
re-lock. If your webcam exposes a hardware zoom, the manual zoom uses that instead for real
optical detail.
</details>

<details>
<summary>Rendering</summary>

Mozilla's PDF.js renders your score into one tall scrollable column that Sightline scrolls
smoothly (or snaps) based on your gaze.
</details>

## Requirements

- A **desktop or laptop with a webcam**.
- **Chrome or Edge** (they support the camera and the face model well).
- Internet access on **first load** (to fetch MediaPipe's face-tracking model and WASM
  runtime — these are large ML assets loaded from Google's CDN rather than bundled; your
  browser caches them after the first visit). PDF.js is bundled with the app itself.

No sample scores are included — load your own PDF. (PDFs are git-ignored so your music never
ends up in the repo.)

## Development

Sightline is a normal Vite-based static web app: plain JS modules, no framework, no server
component. The build output is still just static HTML/CSS/JS — Node/npm are only needed to
build it, not to run it.

```bash
npm install       # install dependencies
npm run dev        # start a local dev server with hot reload
npm test            # run the unit test suite (Vitest)
npm run lint          # lint with ESLint
npm run build           # production build → dist/
npm run preview          # serve the production build locally
```

**Layout:**

- `src/lib/` — pure, dependency-free logic (calibration math, gaze math, staff/system
  detection, the follow-controller's decision logic). This is the part covered by unit
  tests, colocated as `*.test.js` next to each module.
- `src/` (top level) — the DOM-facing modules that wire that logic up to the page: camera
  capture, calibration UI, PDF rendering, the accuracy test, settings/presets, and the
  follow controller's per-frame loop.
- `src/appState.js` — the shared runtime state (calibration, toggles, camera state) that
  those modules read and write.

Pushing to `main` runs the test suite and, if it passes, builds and publishes the app — see
[Host your own copy](#host-your-own-copy).

## Host your own copy

**GitHub Pages** hosts Sightline for free with a shareable HTTPS link (HTTPS means the camera
works anywhere, no local-server step). A GitHub Actions workflow (`.github/workflows/deploy.yml`)
builds the app and publishes it to a `gh-pages` branch on every push to `main`:

1. Push this repo to GitHub and push to `main` at least once (or trigger the *Deploy to GitHub
   Pages* workflow manually) so the `gh-pages` branch gets created.
2. On GitHub: **Settings → Pages**.
3. Under *Build and deployment*, set **Source: Deploy from a branch**, **Branch: `gh-pages` /
   `(root)`**, and Save.
4. Wait a minute, then visit <https://wizoi.github.io/Sightline/>.

From then on, every push to `main` that passes tests automatically redeploys.

Share that link with anyone — they just open it and play.

## Credits & license

Built with [PDF.js](https://mozilla.github.io/pdf.js/) (Mozilla) and
[MediaPipe Tasks](https://developers.google.com/mediapipe) (Google).

Released under the [MIT License](LICENSE).
