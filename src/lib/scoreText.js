// Pure helpers for making sense of a PDF page's *real* embedded text layer
// (from pdfjs' page.getTextContent(), already extracted into plain
// {str, x, y} items by the caller — src/scoreAnalysis.js) — used to detect
// part/section boundaries, tempo markings, and real printed measure
// numbers. This is a fundamentally different, much more reliable technique
// than the pixel-based staff-line/barline scanning elsewhere in lib/: it
// only works when the PDF carries real text (true of scores exported from
// notation software; not true of a scanned/photocopied page), but where it
// applies, it's exact rather than a visual estimate.
//
// Deliberately does NOT read time-signature digits — those are drawn from
// the music engraving's glyph font and have no extractable text value (see
// lib/timeSigMatch.js for the separate, best-effort, shape-based approach
// to that).

// Common tempo markings (Italian, as conventionally printed on scores).
// Single words only for this first pass — multi-word markings like "Allegro
// moderato" aren't matched; a known, acceptable gap rather than something
// worth complicating the matcher for yet.
export const TEMPO_WORDS = [
  'Larghissimo', 'Grave', 'Largo', 'Lento', 'Larghetto',
  'Adagio', 'Adagietto', 'Andante', 'Andantino', 'Moderato',
  'Allegretto', 'Allegro', 'Vivace', 'Vivo', 'Presto', 'Prestissimo',
];

// Whether an item's string is worth keeping at all: real prose contains a
// letter, and a real measure number is a clean run of digits. Deliberately
// excludes everything else, including "text" that turns out to just be
// whitespace or a lone punctuation mark.
function isMeaningful(str) {
  return /[A-Za-z]/.test(str) || /^\d+$/.test(str.trim());
}

// Groups same-row items (within rowEps of each other's y) and joins them
// in x-order into one line of text per row, sorted top-to-bottom. Each row
// also carries `x`, the leftmost item's x — title/instrument-name blocks
// and running-header repeats sit at reliably different x positions (see
// findSectionTitle), so this is the key signal for telling them apart.
//
// Three things matter for correctness here, all found by testing against a
// real score rather than synthetic data:
// (1) A rendered page carries far more items than visible words. Most
// (noteheads, stems) are empty-string, position-only items — the music
// engraving font has no Unicode mapping for them. But some, surprisingly,
// *do* decode to ordinary-looking characters — staccato dots and spacer
// glyphs mapping to "." or extra whitespace was observed on a real PDF.
// Filtering only truly-empty strings isn't enough: isMeaningful() keeps
// only items that contain a letter or are a clean digit run, dropping
// everything else (including that glyph noise) before grouping — both
// because it would corrupt a row's reconstructed text, and because it
// would sit at a bridging y between two genuinely distinct rows (see next
// point). Row text is then built by joining each surviving item's own
// (trimmed) string with a single space, rather than relying on embedded
// space characters or gap-distance heuristics that this glyph noise can't
// be trusted to leave intact.
// (2) The merge check compares against each row's *original* first-item
// y, not a running average that drifts as items are added — with hundreds
// of items per page, a drifting average lets a chain of near-miss items
// bridge two genuinely distinct rows into one.
export function groupIntoRows(items, rowEps = 2) {
  const meaningful = items.filter((it) => isMeaningful(it.str));
  const sorted = [...meaningful].sort((a, b) => b.y - a.y); // top of page first
  const rows = [];
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r.firstY - it.y) <= rowEps);
    if (row) row.items.push(it);
    else rows.push({ firstY: it.y, items: [it] });
  }
  return rows.map((r) => {
    const rowItems = [...r.items].sort((a, b) => a.x - b.x);
    return {
      y: r.firstY,
      x: Math.min(...rowItems.map((it) => it.x)),
      text: rowItems.map((it) => it.str.trim()).join(' ').replace(/\s+/g, ' ').trim(),
    };
  });
}

// First tempo-vocabulary word found anywhere on the page.
export function findTempoMarking(pageItems) {
  for (const it of pageItems) {
    const s = it.str.trim();
    if (TEMPO_WORDS.includes(s)) return { word: s, x: it.x, y: it.y };
  }
  return null;
}

// Candidate instrument/part names from a full-score's first page: rows near
// the left margin that aren't a tempo word or a bare number.
//
// Repetition turned out NOT to be the distinguishing signal (tried first,
// wrong on the real test file): a score prints an instrument's *full* name
// only once, beside its very first system, then an *abbreviated* form
// beside every system after that ("Clarinet in B 1" once, then "B Cl. 1"
// repeated) -- so neither "appears once" nor "appears 2+ times" reliably
// separates a real label from one-off title-block text ("Score", the
// composer's name), which also happens to sit at the left margin.
//
// What actually distinguishes them is position: title-block text sits
// above the music; every staff label, full or abbreviated, sits at or
// below where the first system begins. topSystemY is that system's top
// edge (same y-space as pageRows) -- pad allows for a label sitting
// slightly above the staff it names, which is normal, without reaching all
// the way up to the title block's height above the first system.
export function collectKnownNames(pageRows, topSystemY, { leftMarginX = 120, minLength = 2, pad = 30 } = {}) {
  const seen = new Set();
  const names = [];
  for (const row of pageRows) {
    if (row.x >= leftMarginX) continue;
    if (topSystemY != null && row.y > topSystemY + pad) continue;
    const text = row.text;
    if (!text || text.length < minLength) continue;
    if (TEMPO_WORDS.includes(text) || /^\d+$/.test(text)) continue;
    if (!seen.has(text)) { seen.add(text); names.push(text); }
  }
  return names;
}

// Whether this page is a new part/section's title page: requires BOTH a
// known instrument name sitting at the left margin (the title-block
// position) AND a tempo marking present on the page. Either signal alone
// isn't enough — a continuation page's running header repeats the
// instrument name too (just centered, not at the left margin, and without
// a restated tempo marking), which would otherwise look like a new section
// start every single page.
export function findSectionTitle(pageItems, pageRows, knownNames, { leftMarginX = 120 } = {}) {
  if (!findTempoMarking(pageItems)) return null;
  for (const row of pageRows) {
    if (row.x >= leftMarginX) continue;
    const match = knownNames.find((name) => row.text === name || row.text.startsWith(name));
    if (match) return match;
  }
  return null;
}

// Correlates real printed measure numbers against already-detected systems
// on this page (systemsOnPage: [{ index, yTop, yBottom }], same y-space as
// pageItems). A system with multiple staves repeats its measure number
// once per staff — any of them works, so the closest is used.
//
// pad matters more than it looks: a measure number is engraved *above* the
// staff, not within it -- found consistently ~10pt above a system's own
// detected top edge on a real densely-packed page (9 systems on one page)
// where the un-padded version matched *zero* of 8 real printed numbers on
// the page, silently leaving every system on it stuck with the (sometimes
// badly wrong -- see barlineDetection.js) pixel-only estimate. A page with
// more generous system spacing can happen to still match without any pad,
// which is exactly why this went unnoticed until a tightly-packed page
// surfaced it. pad=20 keeps a real margin over that observed ~10pt while
// staying well under typical system-to-system spacing, so it can't reach
// into a neighboring system's own number.
export function extractMeasureNumbers(pageItems, systemsOnPage, { pad = 20 } = {}) {
  const numberItems = pageItems.filter((it) => /^\d+$/.test(it.str.trim()));
  const results = [];
  for (const sys of systemsOnPage) {
    const candidates = numberItems.filter((it) => it.y <= sys.yTop + pad && it.y >= sys.yBottom);
    if (!candidates.length) continue;
    const best = candidates.reduce((a, b) => (Math.abs(b.y - sys.yTop) < Math.abs(a.y - sys.yTop) ? b : a));
    results.push({ systemIndex: sys.index, measureNumber: parseInt(best.str.trim(), 10) });
  }
  return results;
}

// Printed metronome marks (♩ = N) correlated to the systems they sit above,
// same geometry as extractMeasureNumbers: a mark is engraved just above a
// system's top staff line. The note-value glyph itself is a music-font
// character that pdfjs usually drops or emits separately, but the "= N" part
// comes through the text layer as its own item (verified on MuseScore-style
// exports), so matching `= <number>` is enough. The number is taken as the
// beat-per-minute directly — quarter-note = N is overwhelmingly the common
// case; a non-quarter beat unit (♩. = N, half = N) would be misread, an
// accepted limitation rather than a full glyph-classification effort. Only
// 30–400 is accepted, so a stray "= 5" (a voice/measure artifact) or a huge
// number can't poison the tempo. Returns [{ systemIndex, bpm }].
export function extractTempoMarks(pageItems, systemsOnPage, { pad = 24 } = {}) {
  const markItems = [];
  for (const it of pageItems) {
    const m = it.str.match(/=\s*(\d{2,3})\b/);
    if (!m) continue;
    const bpm = parseInt(m[1], 10);
    if (bpm >= 30 && bpm <= 400) markItems.push({ y: it.y, bpm });
  }
  const results = [];
  for (const sys of systemsOnPage) {
    const candidates = markItems.filter((it) => it.y <= sys.yTop + pad && it.y >= sys.yBottom);
    if (!candidates.length) continue;
    const best = candidates.reduce((a, b) => (Math.abs(b.y - sys.yTop) < Math.abs(a.y - sys.yTop) ? b : a));
    results.push({ systemIndex: sys.index, bpm: best.bpm });
  }
  return results;
}

// Refines the pixel/barline-based measuresPerSystem estimate using real
// printed measure numbers, wherever two *directly adjacent* systems both
// have a known number (their difference is exact). Everywhere else --
// gaps, a section's last system, pages without printed numbers -- the
// original barline-count estimate is left untouched rather than guessed at.
// entries must be sorted by systemIndex ascending (extractMeasureNumbers'
// per-page output, concatenated in page order, already satisfies this).
export function refineMeasureCounts(measuresPerSystem, entries) {
  const refined = [...measuresPerSystem];
  // The very first system always begins at measure 1, even though engravers
  // almost never print a "1" over it. Without this implicit anchor the first
  // system has no left-hand number to diff against the next numbered system,
  // so it can't be refined and stays stuck on the raw pixel/barline estimate
  // -- which is exactly the count most likely to be wrong on a sparse opening
  // full of rests, the clef, time signature and tempo text (a real "30
  // measures instead of 11" miss). Anchoring measure 1 lets the reliable
  // printed number on the next numbered system fix it: e.g. "12" -> 12-1 = 11.
  // Skipped when the first system genuinely carries a printed number already
  // (no duplicate) or when nothing was numbered at all (nothing to diff).
  const anchored = entries.length && entries[0].systemIndex !== 0
    ? [{ systemIndex: 0, measureNumber: 1 }, ...entries]
    : entries;
  for (let k = 0; k < anchored.length - 1; k++) {
    const cur = anchored[k], next = anchored[k + 1];
    if (next.systemIndex - cur.systemIndex !== 1) continue;
    const delta = next.measureNumber - cur.measureNumber;
    if (delta > 0) refined[cur.systemIndex] = delta;
  }
  return refined;
}

// Drops measure-number entries that don't fit a coherent, strictly-increasing
// sequence (in systemIndex order) — a probable misread rather than a real
// number. Real measure numbers only ever climb from one system to the next, so
// the largest strictly-increasing subsequence is the trustworthy set; anything
// off it is discarded, and those systems fall back to the barline estimate
// rather than being "refined" to a wrong exact count. Intended for OCR output
// (image-only PDFs), where a stray digit can be misrecognized off the music —
// and applied PER PAGE, never across pages, so a multi-part score whose numbers
// legitimately reset per part isn't mistaken for a monotonicity break. The
// clean PDF text layer needs no such filtering. Longest-increasing-subsequence
// (O(n^2); n = systems-per-page, tiny). entries need not be pre-sorted.
export function filterMeasureNumberOutliers(entries) {
  if (entries.length <= 1) return entries.slice();
  const sorted = [...entries].sort((a, b) => a.systemIndex - b.systemIndex);
  const n = sorted.length;
  const len = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);
  let bestEnd = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (sorted[j].measureNumber < sorted[i].measureNumber && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
    if (len[i] > len[bestEnd]) bestEnd = i;
  }
  const keep = new Set();
  for (let k = bestEnd; k !== -1; k = prev[k]) keep.add(k);
  return sorted.filter((_, i) => keep.has(i));
}
