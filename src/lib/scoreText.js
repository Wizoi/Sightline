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
      // The row's OWN leftmost item's text, kept alongside the full joined
      // `text` above -- see collectKnownNames' use of this. Real notation
      // software draws a complete instrument name as ONE text run (confirmed
      // on a real 20+-instrument conductor's score: "Alto Saxophone 1",
      // "Clarinet 2 in B", etc. are each already a single item, not built
      // word-by-word), so this is usually just `text` again. It only differs
      // when something ELSE (never part of the real name) shares this row's
      // y and got joined on: most commonly a time-signature glyph sitting at
      // nearly the same y as a compact left-margin name label (see the
      // "6 J"/"b J" note below) -- that noise is always a SEPARATE item
      // appended after the name, never part of it.
      firstItemText: rowItems[0].str.trim(),
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

// A printed metronome mark's "= N" text, shared by extractTempoMarks (which
// correlates it to a system by position) and hasTempoMarking below (which
// just needs to know one exists somewhere on the page). The note-value glyph
// itself (♩, ♩.) is a music-font character pdfjs usually drops or emits
// separately -- see extractTempoMarks.
const TEMPO_MARK_RE = /=\s*(\d{2,3})\b/;

// Shared plausibility bounds for a metronome-mark BPM value — factored into
// one place (previously duplicated as a literal `bpm >= 30 && bpm <= 400` in
// both this file's isPlausibleBpm and extractTempoMarks below) so "enough to
// recognize a section-title page" and "enough to actually set playback
// tempo" can't silently diverge if one copy gets tuned later and the other
// doesn't.
const BPM_MIN = 30;
const BPM_MAX = 400;
function isPlausibleBpmValue(bpm) {
  return bpm >= BPM_MIN && bpm <= BPM_MAX;
}

function isPlausibleBpm(str) {
  const m = str.match(TEMPO_MARK_RE);
  if (!m) return false;
  return isPlausibleBpmValue(parseInt(m[1], 10));
}

// Whether this page carries ANY tempo signal at all, word-based ("Andante")
// OR a bare printed metronome mark ("♩ = 127", read from the text layer as
// just "= 127"). findSectionTitle only needs to know a tempo marking exists
// somewhere on the page, not which system it belongs to, so this is a
// lighter check than extractTempoMarks.
//
// Found on a real 8-file folder of trio scores (IMSLP-sourced): every one of
// them prints ONLY a numeric mark, never an Italian word, so a word-only
// gate silently failed to recognize any of their part-title pages as section
// starts -- confirmed by dumping the real text layer (page 8 titled "B♭
// Clarinet 1", left-margin, matching a known name from page 1 -- every
// condition for findSectionTitle met except this one). Contrast: the one
// real file that already worked (JugglingClowns) happens to print "Andante".
export function hasTempoMarking(pageItems) {
  if (findTempoMarking(pageItems)) return true;
  return pageItems.some((it) => isPlausibleBpm(it.str));
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
//
// Also requires a real run of letters (>= 2 consecutive) somewhere in the
// text -- found necessary on a real dense 20+-instrument conductor's score
// ("The Fantastic Parade"): its compact left-margin layout puts each
// instrument's OWN time-signature digits at nearly the same y as that
// instrument's name label, so groupIntoRows (correctly, by its own rules)
// merges them into one row, producing garbage candidates like "6 J" or "b J"
// (the "J" a stray music-font glyph that happens to decode to an ordinary
// letter -- the same class of surprising glyph-decode noted on groupIntoRows
// itself). A real instrument name or abbreviation always has a letter run
// this long ("B Cl. 1", "A.Cl." from a real abbreviated label), so this
// rejects the pure-noise fragments without rejecting any real one -- it
// does NOT fully clean a compound row like "Oboes 8 J" (kept, since "Oboes"
// still qualifies), but those are far less likely to spuriously re-match a
// later page verbatim than a short, pure-noise fragment is.
function hasRealNameShape(text) {
  return /[A-Za-z]{2,}/.test(text);
}

// Returns [{ text, isFull }]. `firstSystem` (the bootstrap page's own first
// system, { yTop, yBottom } in the same y-space as pageRows) distinguishes
// which form each collected label is:
//   - isFull: true  -- the row sits within (or up to `pad` above) system 0's
//     OWN vertical band. A combined score's first system braces every
//     instrument at once, each stacked at its own y but all within that one
//     system's rowMin..rowMax -- this is where a FULL name is printed
//     ("Clarinet in B 1"), exactly once, per the real engraving convention
//     documented above.
//   - isFull: false -- the row sits below system 0's own band, i.e. beside
//     some LATER system on the bootstrap page. Every system after the first
//     only ever reprints the ABBREVIATED form ("B Cl. 1"), every page,
//     forever -- see findSectionTitle for why this distinction matters: an
//     abbreviated label is real but re-matches on every continuation page of
//     a combined score, which is NOT a section boundary.
// firstSystem may be null (no systems detected on the bootstrap page at
// all) -- in that case nothing above the page can be excluded and every
// remaining candidate is treated as isFull (the old, pre-tagging behavior),
// same as when topSystemY was null before this function distinguished forms.
function isCandidateName(text, minLength) {
  if (!text || text.length < minLength) return false;
  if (TEMPO_WORDS.includes(text) || /^\d+$/.test(text)) return false;
  return hasRealNameShape(text);
}

export function collectKnownNames(pageRows, firstSystem, { leftMarginX = 120, minLength = 2, pad = 30 } = {}) {
  const topY = firstSystem ? firstSystem.yTop : null;
  const bottomY = firstSystem ? firstSystem.yBottom : null;
  const seen = new Set();
  const names = [];
  for (const row of pageRows) {
    if (row.x >= leftMarginX) continue;
    if (topY != null && row.y > topY + pad) continue;
    const isFull = bottomY == null || row.y >= bottomY;

    if (isCandidateName(row.text, minLength) && !seen.has(row.text)) {
      seen.add(row.text);
      names.push({ text: row.text, isFull });
    }

    // A compact left-margin layout can put an unrelated glyph (most often a
    // time-signature digit) at nearly the same y as a real instrument-name
    // label, so groupIntoRows -- correctly, by its own row-merge rules --
    // joins them into one row ("Oboes 8 J"). Real notation software draws a
    // complete instrument name as ONE text item (confirmed on a real 20+-
    // instrument conductor's score: "Alto Saxophone 1", "Clarinet 2 in B",
    // etc. are each already a single item, never built word-by-word), so
    // the row's own leftmost item's text (row.firstItemText) is usually
    // just the SAME, clean, uncontaminated name even when the full joined
    // row.text got noise appended after it. Adding it as a SECOND candidate
    // (rather than replacing row.text) recovers the name for later
    // prefix-matching (findSectionTitle) on this exact real file, where the
    // joined-row text's trailing noise otherwise permanently blocks every
    // future match: "Oboes 8 J" is never a prefix of a later page's clean
    // "Oboes ..." row, but "Oboes" alone is. Harmless when row.text is
    // already clean (firstItemText then just duplicates it, caught by the
    // `seen` check) and harmless for a genuinely multi-line label like
    // "Piccolo/" + "Flute" on separate rows (each row's own first item IS
    // already that row's whole text, so this adds nothing new there either).
    if (row.firstItemText !== row.text && isCandidateName(row.firstItemText, minLength) && !seen.has(row.firstItemText)) {
      seen.add(row.firstItemText);
      names.push({ text: row.firstItemText, isFull });
    }
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
//
// Only a knownNames entry with isFull:true is accepted as a match here — a
// real bug found on a real multi-part "Score and Parts"-style file:
// mid-Score CONTINUATION pages (every instrument still braced together, not
// a new part at all) legitimately show an ABBREVIATED per-staff label at
// the left margin on every page of the Score, plus the score's own numeric
// tempo mark restated at the top of each page -- both real signals, but
// present on every continuation page, not just a genuine new section start.
// A genuine new part's own opening page always (re)prints that part's FULL
// name (per the same "full once, abbreviated after" engraving convention
// collectKnownNames relies on) -- so requiring isFull filters out the
// false-positive continuation-page trigger without losing any real one.
//
// Returns the MATCHED ROW's own text, not the stored knownName's text --
// found to matter on several real "Score and Parts" IMSLP files where a
// combined score's braced staves for "Clarinet 1"/"Clarinet 2" print the
// SAME unnumbered label ("B♭ Clarinet") beside each staff (the reader tells
// them apart by position, not by a printed numeral), so collectKnownNames'
// dedup only ever keeps ONE generic "B♭ Clarinet" knownName -- but each
// part's own opening page (this function's actual match target) DOES print
// its real, distinguishing numbered name ("B♭ Clarinet 1", "B♭ Clarinet 2").
// Since a match is only ever accepted when the row's text equals or starts
// with the known name (never the reverse), the row's own text is always at
// least as specific -- returning it instead of match.text is strictly safe
// and fixes both parts being named identically.
export function findSectionTitle(pageItems, pageRows, knownNames, { leftMarginX = 120 } = {}) {
  if (!hasTempoMarking(pageItems)) return null;
  for (const row of pageRows) {
    if (row.x >= leftMarginX) continue;
    const match = knownNames.find((n) => n.isFull && (row.text === n.text || row.text.startsWith(n.text)));
    if (match) return row.text;
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
    const m = it.str.match(TEMPO_MARK_RE);
    if (!m) continue;
    const bpm = parseInt(m[1], 10);
    if (isPlausibleBpmValue(bpm)) markItems.push({ y: it.y, bpm });
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

// Splits `total` measures as evenly as possible across `span` systems whose own
// numbers are missing but which are bracketed by two known ones (largest-
// remainder rounding, so the parts sum to exactly `total`, each >= 1, the
// bigger ones first). Deliberately even, not weighted by the barline estimate:
// inside a gap that estimate is the very signal we don't trust (a system's
// number was missing precisely because reading failed there, and barline can be
// noisy or even anti-correlated with the true count on dense music — validated
// on a real image-only lead sheet, where even splitting recovered the true
// counts and barline-weighted splitting did not). What matters for scroll
// timing is that the total is pinned exactly at both ends; the split within a
// short gap is minor and self-corrects at the next known number. Returns null
// when `total` can't cover one measure each — implausible, so the caller leaves
// the barline estimate.
function distributeMeasures(total, span) {
  if (total < span) return null;
  const base = Math.floor(total / span);
  let extra = total - base * span; // the leftover, spread one-each over the first `extra`
  const out = [];
  for (let i = 0; i < span; i++) out.push(base + (extra-- > 0 ? 1 : 0));
  return out;
}

// Refines the pixel/barline-based measuresPerSystem estimate using real printed
// measure numbers. Between every pair of consecutive known numbers the exact
// total measures is known: if they sit on directly adjacent systems that total
// IS that system's count (exact); if a gap of systems whose own numbers weren't
// found sits between them, the total is distributed across that gap
// (distributeMeasures) rather than dropping those systems back to the raw
// barline estimate — the numbers are still the authority, just shared out.
// Systems past the last known number (or before the first, absent the anchor
// below) keep their barline estimate. entries need not be pre-sorted.
export function refineMeasureCounts(measuresPerSystem, entries) {
  const refined = [...measuresPerSystem];
  // The very first system always begins at measure 1, even though engravers
  // almost never print a "1" over it. Without this implicit anchor the first
  // system(s) have no left-hand number to diff against and stay stuck on the
  // raw barline estimate -- exactly the count most likely to be wrong on a
  // sparse opening full of rests, the clef, time signature and tempo text (a
  // real "30 measures instead of 11" miss). Anchoring measure 1 lets the next
  // known number fix it: "12" -> 12-1 = 11. Skipped when the first system
  // already carries a printed number, or nothing was numbered at all.
  const sorted = [...entries].sort((a, b) => a.systemIndex - b.systemIndex);
  const anchored = sorted.length && sorted[0].systemIndex !== 0
    ? [{ systemIndex: 0, measureNumber: 1 }, ...sorted]
    : sorted;
  for (let k = 0; k < anchored.length - 1; k++) {
    const cur = anchored[k], next = anchored[k + 1];
    const span = next.systemIndex - cur.systemIndex;
    const total = next.measureNumber - cur.measureNumber;
    if (span < 1 || total <= 0) continue;
    if (span === 1) { refined[cur.systemIndex] = total; continue; } // adjacent: exact
    const dist = distributeMeasures(total, span); // gap: share the known total across it
    if (dist) for (let s = 0; s < span; s++) refined[cur.systemIndex + s] = dist[s];
  }
  return refined;
}

// Drops measure-number entries that don't fit a coherent, strictly-increasing
// sequence (in systemIndex order) — a probable misread rather than a real
// number. Real measure numbers only ever climb from one system to the next, so
// the largest strictly-increasing subsequence is the trustworthy set; anything
// off it is discarded, and those systems fall back to interpolation/barline
// rather than being "refined" to a wrong exact count. Intended for OCR output
// (image-only PDFs), where a stray digit can be misrecognized off the music —
// and applied per PAGE (inside the per-page loop, before a page's entries are
// added to the whole-document list) and again per SECTION once part
// boundaries are known (`analyzeScore()`), never across a whole multi-part
// document in one pass, so a score whose numbers legitimately reset per part
// isn't mistaken for a monotonicity break (see detectMeasureNumberResets,
// which finds exactly those legitimate resets and turns them into section
// boundaries in the first place). The clean PDF text layer needs no per-page
// filtering but still gets the per-section pass for the same reason.
// Longest-increasing-subsequence (O(n^2); n = entries in the group being
// checked, always small). entries need not be pre-sorted.
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

// Detects a new part/section starting purely from its printed measure
// numbers resetting -- e.g. a page that begins renumbering at 1 -- with NO
// dependency on a matched instrument name. This is the one section-boundary
// signal that still works on a PDF with no combined-score bootstrap page for
// collectKnownNames to draw instrument names from at all (a booklet of
// individual scanned parts, no "score" page ever printed) -- see
// analyzeScore()'s known limitation on that bootstrap. Real measure numbers
// only ever climb within a single part, so any DROP is either a genuine part
// restart or a misread; `maxRestart` narrows it to the former by requiring
// the post-drop number to be small (a real restart is always 1, occasionally
// 2-3 for a pickup measure) -- an arbitrary same-page-adjacent drop to some
// other, larger value is left alone (refineMeasureCounts' own `total <= 0`
// guard already keeps a single stray misread from corrupting its system;
// this function's job is specifically to recognize the confident case: a
// real new part, worth a whole section boundary for).
//
// Also requires the very NEXT entry (if any) to genuinely be greater than
// the drop -- i.e. numbering actually resumes climbing from there, not just
// a one-off dip. Found necessary on a real trio score ("A Lazy Summer Day"):
// a mis-extracted "2" (almost certainly some OTHER printed digit --
// possibly a second-player suffix like "Flute 2" -- being picked up as if
// it were a measure number, not a real restart) repeated identically across
// SEVERAL consecutive systems. Without this check, every one of those
// systems still only fires once (the first one triggers on the drop; the
// following identical repeats aren't drops at all), but that single firing
// was still a false section boundary, since nothing about a flatlined
// repeat looks like real, climbing measure numbering. Requiring the next
// reading to be strictly greater rejects exactly that flatline case (next
// reading is the same repeated bad value, not greater) while still
// accepting every real restart already covered by this function's tests
// (which all climb normally afterward). Not airtight -- a truly isolated
// one-off misread that happens to be followed by a real, further-climbing
// number can still slip through -- but it removes the worst, most visible
// failure mode (one bad reading fragmenting a document into several bogus
// generic sections) found on a real, multi-file corpus sweep.
//
// entries need not be pre-sorted. Returns the systemIndex of each detected
// reset (the system where the LOWER number was printed -- i.e. the new
// part's own first system), each usable directly as a boundary systemIndex
// for buildSections.
// A section a reset introduces spans from that reset's own systemIndex up to
// the next accepted reset (or the document's end, at `systemCount`). A real
// system always holds at least one real measure, so a genuine section's own
// printed numbers should climb to a value at least roughly comparable to how
// many systems the section spans -- an entire section 40, 140, even 380
// systems long whose own readings never climb past single digits (or a lone
// outlier) isn't real measure-numbering at all, no matter how "confidently"
// each individual drop-then-climb looked in isolation. Found on a real
// duets collection ("Lazarus 3 Grand Artistic Duets") with especially poor,
// near-random OCR: every one of its 9 candidate resets individually passed
// the drop/climb checks above, yet the sections they introduced spanned
// 9-143 systems while their own readings never climbed past single digits
// (one lone outlier reaching 41) -- ratios of (max reading found) / (span)
// of 0.07-0.29, starkly below the >=1 a real multi-system section should
// comfortably clear. Contrast a real, already-working sparse case
// ("KingCotton.pdf"): only 5 and 2 readings in its two sections, but their
// own max values (173, 173) against their spans (104, 61) give ratios of
// 1.66 and 2.84 -- genuinely plausible, not just "a small number of samples
// that happen to look fine." minSamples guards the OTHER direction: a
// section with too FEW readings to compute this ratio meaningfully (found
// on real, already-working sparse files -- "Fat Burger," 1 reading in its
// one reset-introduced section) is left alone entirely rather than
// second-guessed on scant evidence -- this check only ever REJECTS a
// candidate reset when there's enough corroborating data to be confident
// it's implausible, never when data is merely sparse.
const MIN_RATIO = 0.5;
const MIN_SAMPLES_FOR_RATIO_CHECK = 3;

function plausibleSectionSpan(resetIndex, allResetIndices, systemCount, entries) {
  if (systemCount == null) return true; // no span to check against -- caller didn't opt in
  const laterBounds = allResetIndices.filter((r) => r > resetIndex);
  const segEnd = laterBounds.length ? Math.min(...laterBounds) : systemCount;
  const span = segEnd - resetIndex;
  if (span <= 0) return true; // shouldn't happen, but never reject on a degenerate span
  const segReadings = entries.filter((e) => e.systemIndex >= resetIndex && e.systemIndex < segEnd);
  if (segReadings.length < MIN_SAMPLES_FOR_RATIO_CHECK) return true; // not enough evidence either way -- don't second-guess a sparse real section
  const max = Math.max(...segReadings.map((e) => e.measureNumber));
  return max / span >= MIN_RATIO;
}

export function detectMeasureNumberResets(entries, { maxRestart = 3, systemCount } = {}) {
  if (entries.length < 2) return [];
  const sorted = [...entries].sort((a, b) => a.systemIndex - b.systemIndex);
  const resets = [];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    if (cur.measureNumber >= sorted[i - 1].measureNumber || cur.measureNumber > maxRestart) continue;
    const next = sorted[i + 1];
    if (next && next.measureNumber <= cur.measureNumber) continue; // doesn't resume climbing -- likely a misread, not a real restart
    resets.push(cur.systemIndex);
  }
  return resets.filter((r) => plausibleSectionSpan(r, resets, systemCount, sorted));
}
