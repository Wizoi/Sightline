// Populates public/fonts/ with Bravura, the SIL Open Font License-licensed
// SMuFL reference music-engraving font, so timeSigDetection.js can render its
// actual time-signature digit glyphs (codepoints timeSig0-timeSig9, U+E080-
// U+E089) as match templates instead of a plain sans-serif ctx.font render —
// see lib/timeSigMatch.js's header and docs/PERSONAS.md persona 3's
// 2026-07-23 write-up for why this closes a real gap (a generic UI font's
// digit shapes are a poor stand-in for an actual engraving font's).
//
// Same reasoning and pattern as scripts/fetch-ocr-assets.mjs /
// fetch-mediapipe-assets.mjs: fetched once at dev/build time (see package.json
// pre-scripts) and served from this app's own origin, never a third-party CDN
// at runtime. Safe to run repeatedly — skips work already done.
//
// public/fonts/ is git-ignored: Bravura.woff2 is ~247KB, fetched from a
// version-pinned tag of Steinberg's own steinbergmedia/bravura GitHub repo
// (not master, so this can't silently change under us), verified license:
// SIL OFL 1.1 (redist/OFL.txt in that repo) -- free to bundle/embed/
// redistribute; the only restrictions are against selling the font standalone
// and against reusing the reserved name "Bravura" for a modified derivative,
// neither of which applies to using it as-is for template rendering here.

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const DEST = path.join(root, 'public', 'fonts');
const FONT_DEST = path.join(DEST, 'Bravura.woff2');

// Pinned to a specific tag (not `master`) so this asset can't drift underneath
// the app between builds -- bump deliberately if a future Bravura release is
// ever worth picking up.
const BRAVURA_TAG = 'bravura-1.392';
const FONT_URL = `https://raw.githubusercontent.com/steinbergmedia/bravura/${BRAVURA_TAG}/redist/woff/Bravura.woff2`;

async function fetchIfMissing() {
  if (existsSync(FONT_DEST) && statSync(FONT_DEST).size > 0) {
    console.log('[bravura-assets] Bravura.woff2 already present, skipping download');
    return;
  }
  mkdirSync(DEST, { recursive: true });
  console.log('[bravura-assets] downloading Bravura.woff2 (one-time)...');
  const res = await fetch(FONT_URL);
  if (!res.ok) throw new Error(`Failed to download Bravura.woff2: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(FONT_DEST, buf);
  console.log(`[bravura-assets] saved font to public/fonts/ (${(buf.length / 1e6).toFixed(2)}MB)`);
}

await fetchIfMissing();
