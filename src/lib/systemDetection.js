import { mean, median } from './mathUtils.js';
import { clusterVals, kmeans2 } from './clustering.js';

// Detect musical SYSTEMS (not individual staves) from a page's staff-line
// row positions. Works for full scores where several instrument staves are
// braced into one system AND for single-staff parts. Method: cluster the
// staff-line rows into staves (5 lines each), then group staves into systems
// — but only when the grouping is consistent (equal staves per system, like
// a real score); otherwise each staff is its own system.
//
// `lineRows` are row indices (in the same coordinate space the caller
// measured them in) where a staff line was detected.
export function pageSystems(lineRows) {
  return pageSystemsDetailed(lineRows).map((s) => s.center);
}

// A physical staff line rendered with any anti-aliasing/thickness commonly
// registers as 2-3 adjacent "ink" rows instead of exactly 1 (confirmed
// against a real rendered PDF, not hypothetical). Left alone, those tiny
// thickness gaps (often 1px) get mixed into the same gap statistics used
// below to size the staff-line clustering cutoff, dragging the median (and
// so the cutoff) down so far that real, larger gaps between distinct lines
// no longer cluster together at all — every line ends up "alone". Collapsing
// near-duplicate rows into one representative point first removes that
// noise at the source. A real gap between two distinct staff lines is
// essentially never this small (if it were, the lines wouldn't be
// separately resolvable in the image at all), so this is safe.
//
// The per-step `maxGap` check alone is NOT enough on a densely-packed page,
// though — found on a real 20+-instrument conductor's score ("The Fantastic
// Parade"), where fitting 23 staves into the shared ah=1200 analysis canvas
// shrinks real line-to-line spacing down to ~2-3px, the SAME magnitude as
// the anti-aliasing-duplicate-row gap this function was written to collapse.
// A chain of small per-step gaps (each individually <= maxGap, since a
// doubled-row line's own internal gap and the gap to the NEXT real line's
// first doubled row can both read as 1-2px at this scale) then greedily
// single-linkage-merges an entire 5-line staff into ONE point instead of 5 --
// confirmed directly against real dumped row/ink data: two real staves
// (Tenor Saxophone, Baritone Saxophone) that visibly render full 5-line
// staves collapsed to a single representative row, silently discarding 4 of
// their 5 lines and, downstream, corrupting that system's whole-page
// grouping. Capping the group's TOTAL span from its first row (not just each
// step) at the same maxGap threshold fixes this: a genuine thickness-
// duplicate group is documented above as spanning only 1-2px total (2-3
// adjacent rows), well inside this cap, so the original bug's fix is
// unaffected; a real next staff line 2-3px away now correctly starts a new
// group once the running span would exceed that small, physically-plausible
// single-line-thickness bound, instead of chaining indefinitely.
function collapseThickness(rows, maxGap = 2) {
  const out = [];
  let cur = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] - cur[cur.length - 1] <= maxGap && rows[i] - cur[0] <= maxGap) cur.push(rows[i]);
    else { out.push(mean(cur)); cur = [rows[i]]; }
  }
  out.push(mean(cur));
  return out;
}

// Same detection as pageSystems(), but also returns each system's row
// extent (rowMin/rowMax spanning the staff lines that compose it) — needed
// by barline detection (lib/barlineDetection.js) to know which vertical
// band of the page to scan. pageSystems() is a thin wrapper around this
// that keeps its original centers-only contract for existing callers (Snap
// mode) — the two never duplicate the clustering logic itself.
export function pageSystemsDetailed(rawLineRows) {
  if (rawLineRows.length < 2) {
    return rawLineRows.map((r) => ({ center: r, rowMin: r, rowMax: r }));
  }
  const lineRows = collapseThickness(rawLineRows);
  if (lineRows.length < 2) {
    return lineRows.map((r) => ({ center: r, rowMin: r, rowMax: r }));
  }
  const sp = [];
  for (let i = 1; i < lineRows.length; i++) sp.push(lineRows[i] - lineRows[i - 1]);
  const med = median(sp) || 5;
  // A staff needs at least 2 of its 5 lines to register as "ink" to count.
  // Confirmed against a real multi-staff score (a clarinet quartet): a staff
  // with several consecutive whole-measure rests produced only 2 detected
  // lines instead of 5 (rest-heavy passages apparently don't always reinforce
  // every line the way note-dense ones do), and dropping that staff entirely
  // (the old >=3 threshold) didn't just lose one staff's extent -- it changed
  // the gap between its neighbors enough to make the *whole page's* grouping
  // look inconsistent, silently falling every system back to one-staff-per-
  // system for a page that's actually cleanly 4-braced throughout. Verified
  // across all 13 pages of that real file: this loosened threshold fixes the
  // 3 affected pages and changes nothing on the other 10 (including
  // single-staff instrument-part pages, where nothing this loose should ever
  // spuriously cluster since real staff lines are never just 2px apart).
  const staves = clusterVals(lineRows, Math.max(3, med * 1.9)).filter((g) => g.length >= 2);
  const staffInfo = staves.map((g) => ({ center: mean(g), rowMin: Math.min(...g), rowMax: Math.max(...g) }));
  if (staffInfo.length < 2) return staffInfo.slice();

  const sc = staffInfo.map((s) => s.center);
  const gaps = [];
  for (let i = 1; i < sc.length; i++) gaps.push(sc[i] - sc[i - 1]);
  const [lo, hi] = kmeans2(gaps);
  const bimodalRatio = (hi - lo) / Math.max(lo, 1);
  // 0.3 was never validated against a real multi-page combined score, only
  // guessed -- found too high on a real "Score and Parts"-style IMSLP corpus
  // (a whole cluster of trio files, e.g. "East Meets West", "Cuban Dancer
  // Trio"): a combined score's CONTINUATION pages (more systems per page than
  // its own opening page, so less breathing room between them) real
  // within-brace vs. between-system gap ratio measures as low as 0.20-0.26
  // across many real pages/files -- comfortably bimodal to a human looking at
  // the rendered page, but below this gate, so those pages never even
  // attempted grouping and fell back to one system per staff (e.g. 12 solo-
  // looking "systems" instead of the real 4 three-staff systems).
  //
  // Simply lowering this gate everywhere was tried first and found UNSAFE by
  // the same git-stash A/B discipline as the fixes below: on the real
  // "Full band arrangements" regression-guard files (scanned single-staff
  // booklets, NO real bracing anywhere), a page's naturally-varying scan
  // noise can ALSO clear a lowered gate (e.g. Teutonia p.16's real gaps
  // [112.7, 104.3, 124.5, 95.2] measure 0.189; MonogramMarch p.7 measures
  // 0.251) and then get accepted by the >=3-group branch's existing
  // "tolerate one non-conforming group" tolerance, which a near-uniform
  // noise pattern can satisfy by accident (these two pages both produced
  // groups of size [1, 2, 2] -- two coincidental "pairs" -- which the
  // tolerant rule can't tell apart from a real repeated 2-staff brace).
  // That tolerance is legitimate and already verified safe at the ORIGINAL
  // 0.3 gate (a real 13-page braced quartet file), so the fix isn't to
  // remove it -- it's to only extend the LOWERED gate's benefit to splits
  // that don't need that tolerance at all. A real combined score's own
  // repeated bracing is much stronger evidence than "noise happened to look
  // bimodal": every real system on a page uses the SAME instrumentation, so
  // a genuine multi-staff page groups into PERFECTLY equal-sized groups
  // (confirmed on the real IMSLP trio pages: 4 groups of exactly 3, every
  // time) with no exceptions needed. So a WEAK bimodal signal (0.15-0.3) is
  // only trusted when the resulting grouping is perfect (every group the
  // same size); the original 0.3 gate keeps its existing tolerance
  // (including the n=2 exact-match and singleton-brace rules below) for a
  // STRONG signal. Verified via git-stash A/B against all four real
  // regression-guard files: with this two-tier gate, Teutonia p.16 and
  // MonogramMarch p.7 (the two pages a flat lowered gate broke) are
  // confirmed byte-for-byte back to their original ungrouped state, while
  // the real IMSLP trio pages (ratio 0.20-0.26, perfectly uniform groups)
  // still correctly merge.
  const WEAK_BIMODAL_RATIO = 0.15;
  const STRONG_BIMODAL_RATIO = 0.3;
  if (bimodalRatio >= WEAK_BIMODAL_RATIO) {           // gaps look bimodal → maybe grouped
    // group staffInfo the same way clusterVals would group sc, but carrying
    // the full staff records along so extents survive the grouping.
    const cutoff = (lo + hi) / 2;
    const grp = [[staffInfo[0]]];
    for (let i = 1; i < staffInfo.length; i++) {
      const last = grp[grp.length - 1];
      if (staffInfo[i].center - last[last.length - 1].center <= cutoff) last.push(staffInfo[i]);
      else grp.push([staffInfo[i]]);
    }
    const sizes = grp.map((g) => g.length);
    const counts = {}; let modeSize = sizes[0], best = 0;
    sizes.forEach((s) => { counts[s] = (counts[s] || 0) + 1; if (counts[s] > best) { best = counts[s]; modeSize = s; } });
    // "tolerate at most one non-conforming group" (best >= grp.length - 1) is
    // VACUOUS when there are only 2 groups: best is always >= 1 for any 2
    // groups (whichever size wins the tie), so this check could never reject
    // a 2-way split no matter how mismatched the two sizes were. Confirmed as
    // a real bug via a real scanned single-staff-part booklet ("Teutonia.pdf",
    // Full band arrangements folder): a page with 7 solo staves (no real
    // bracing anywhere in this document) produced gaps of mostly ~90-125 plus
    // ONE much larger outlier (a scan/binding irregularity, not a real
    // system-vs-staff distinction), which kmeans2 saw as "bimodal" and split
    // into exactly 2 groups of sizes 3 and 4 -- accepted as "consistent"
    // purely because grp.length-1 == 1 == best, even though the two group
    // sizes plainly don't match. A real multi-staff score reuses the SAME
    // instrumentation every system, so two real systems on one page should
    // have the same staff count; requiring exact equality when there are
    // only 2 groups (instead of "at most one off", which can't discriminate
    // at n=2) closes this loophole without touching the >=3-group case
    // (already verified safe against a real 13-page braced quartet file, see
    // the "tolerates a staff with only 2 of 5 lines detected" test/comment
    // above) at all.
    // A SECOND real n=2 shape, found on a real 20+-instrument conductor's
    // score ("Full band arrangements/Fantastic Parade.pdf"): one lone staff
    // (a percussion staff notated on its own, never braced with the winds/
    // brass ensemble above it) sits right after the page's one real big
    // system, producing exactly 2 groups of sizes [20, 1] -- rejected by the
    // exact-match rule above (20 !== 1), which fell the WHOLE page back to
    // 21 separate one-staff systems, destroying the correctly-detected
    // 20-staff brace along with it (confirmed directly: this file's real
    // system count went from the true 315 to 480, almost entirely from this
    // one page shape repeating across all 9 of its real combined-score
    // pages).
    //
    // A size-1 group can never itself be internally "inconsistent," but a
    // naive "singleton pairs with anything" rule was tried first and found
    // UNSAFE by the same git-stash A/B discipline as the fix above: on the
    // real scanned single-staff booklets this project already treats as
    // regression guards (Teutonia/MonogramMarch/KingCotton/Fat Burger --
    // NO real bracing anywhere in any of them), several pages show this
    // EXACT [N, 1] shape too, purely from scan/binding noise (one outlier
    // gap happening to isolate an edge staff) -- e.g. Teutonia p.9's real
    // gaps [212.3, 118.3, 112, 120.4, 106.3] split into sizes [1, 5], and
    // accepting that merged 5 genuinely separate solo staves into one fake
    // system spanning 474 (of a 1200-row canvas). The false-positive "big"
    // side topped out at size 9 (Fat Burger p.31) across all four files'
    // real pages -- nowhere close to Fantastic Parade's real 20. Gating the
    // exception on the non-singleton side being LARGE (>= MIN_BRACE_SIZE)
    // exploits that real, verified gap: this app already fixes every page
    // to the same ah=1200 analysis canvas (see scoreAnalysis.js), so "20+
    // staves detected in one page-local group" is a comfortably rare, high-
    // confidence signal specific to a genuinely huge conductor-score brace,
    // not something ordinary scan noise on a solo-part booklet plausibly
    // produces. 15 sits with real margin above the worst confirmed false
    // positive (9) and real margin below the confirmed genuine case (20) --
    // same calibration discipline as this file's other real thresholds.
    // Verified via git-stash A/B against all four real regression-guard
    // files: every one of the 15 false-positive pages found while
    // developing this fix (5 more than shown above, across all 4 files)
    // stays correctly un-merged with this gate in place, while Fantastic
    // Parade's 9 real combined-score pages still correctly merge.
    const MIN_BRACE_SIZE_FOR_SINGLETON_EXCEPTION = 15;
    const isSingletonPlusGroup = grp.length === 2 && sizes.includes(1)
      && sizes.some((s) => s >= MIN_BRACE_SIZE_FOR_SINGLETON_EXCEPTION);
    // A weak signal (didn't clear the original 0.3 gate) only gets the
    // STRICT form of each check -- perfect equality, no "tolerate one off"
    // and no singleton exception (Fantastic Parade's real case clears 0.3
    // comfortably on its own, so it never needs the weak band) -- see the
    // bimodalRatio doc comment above for why.
    const strong = bimodalRatio >= STRONG_BIMODAL_RATIO;
    const consistent = grp.length === 2
      ? (best === 2 || (strong && isSingletonPlusGroup))
      : (strong ? modeSize > 1 && best >= grp.length - 1 : best === grp.length);
    if (consistent) {       // consistent multi-staff systems
      return grp.map((g) => ({
        center: mean(g.map((s) => s.center)),
        rowMin: Math.min(...g.map((s) => s.rowMin)),
        rowMax: Math.max(...g.map((s) => s.rowMax)),
      }));
    }
  }
  return staffInfo.slice();                            // otherwise: each staff is its own system
}
