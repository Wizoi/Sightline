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

// Refines the pixel/barline-based measuresPerSystem estimate using real
// printed measure numbers, wherever two *directly adjacent* systems both
// have a known number (their difference is exact). Everywhere else --
// gaps, a section's last system, pages without printed numbers -- the
// original barline-count estimate is left untouched rather than guessed at.
// entries must be sorted by systemIndex ascending (extractMeasureNumbers'
// per-page output, concatenated in page order, already satisfies this).
export function refineMeasureCounts(measuresPerSystem, entries) {
  const refined = [...measuresPerSystem];
  for (let k = 0; k < entries.length - 1; k++) {
    const cur = entries[k], next = entries[k + 1];
    if (next.systemIndex - cur.systemIndex !== 1) continue;
    const delta = next.measureNumber - cur.measureNumber;
    if (delta > 0) refined[cur.systemIndex] = delta;
  }
  return refined;
}
