// Integration-style tests that exercise the REAL PDF text-layer extraction
// pipeline (pdfjs-dist's page.getTextContent(), the same call
// scoreAnalysis.js makes) against genuine, synthetically-built PDF byte
// streams — not hand-typed {str, x, y} arrays like scoreText.test.js's unit
// tests. This is the Phase 1b fixture work: a committed regression test that
// actually renders/parses a real PDF, targeting the specific structural
// conditions that caused real bugs (see docs/PERSONAS.md persona 3).
//
// Fixtures are built IN-MEMORY at test time via `pdf-lib` (a pure-JS PDF
// author, no native deps) rather than committed as static .pdf binary
// files, for two independent reasons:
//   1. This repo's .gitignore has a deliberate blanket `*.pdf` rule whose
//      whole purpose is to make it structurally hard to ever accidentally
//      commit the user's real, copyrighted personal sheet-music collection
//      (see the file loading/corpus-testing methodology elsewhere in this
//      project). Adding a carved-out exception for a fixtures folder would
//      be a real, if narrow, weakening of that safety net for an
//      unnecessary reason -- generating the bytes at test time gets the
//      same coverage without ever touching that rule.
//   2. It keeps the fixture fully readable as plain JS right here, next to
//      the assertions that exercise it -- a reviewer never has to open a
//      binary file to know what's in a "fixture."
// The bytes handed to pdfjs-dist's getDocument({ data: bytes }) are still a
// REAL, complete PDF byte stream, parsed by the actual production pdfjs
// pipeline (real xref table, real content streams, real font/glyph
// decoding) -- this is what makes it meaningfully different from (and a
// genuine complement to) the existing hand-typed-item unit tests: it would
// have caught a real pdfjs API-shape regression (e.g. a getTextContent()
// item field renamed) that a hand-typed fixture never could.
//
// What this DOESN'T cover (see docs/PERSONAS.md persona 3's Phase 1b
// write-up for the full reasoning): anything that needs page.render() to a
// canvas -- staff-line/barline pixel detection, the rotation-probe's
// per-orientation ink scoring. No `canvas` npm package or jsdom is
// installed in this project (confirmed: plain Node, no DOM), and adding
// native canvas bindings as a permanent devDependency was a deliberate
// non-goal (this project's QA persona already treats Playwright-driven
// rendering as ad hoc, session-only verification, never committed test
// infra — see .claude/agents/qa-test-strategist.md). Pixel-dependent logic
// stays tested at the seam it's already tested at: pure functions
// (pageSystemsDetailed, estimateMeasureCount) fed literal row/ink arrays
// (systemDetection.test.js, barlineDetection.test.js) — including two new
// regression tests added directly from real corpus-dumped gap data (see
// Finding 1 in docs/PERSONAS.md). Where this fixture file needs a "systems
// on this page" input (real code gets that from the pixel pass), it uses an
// explicit, clearly-labeled SYNTHETIC systemsForText array positioned to
// match where this fixture's own text was drawn — standing in for the one
// step this file doesn't exercise, not a shortcut on the parts it does.

import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import {
  groupIntoRows, collectKnownNames, findSectionTitle, extractMeasureNumbers, detectMeasureNumberResets,
} from './scoreText.js';

// Mirrors scoreAnalysis.js's own extraction: pdfjs items -> plain {str, x, y}.
function toPlainItems(content) {
  return content.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
}

// NOTE: pdfjs logs a few harmless console warnings under this project's
// plain-Node (no canvas/jsdom) test environment -- "Cannot polyfill
// DOMMatrix/Path2D" and "fetchStandardFontData ... baseUrl" -- both about
// rendering/font-metrics machinery that real text-position extraction below
// never touches. Confirmed inert (all assertions below still pass); not
// worth chasing pdfjs-dist's verbosity API to silence them.
async function loadPdf(bytes) {
  return pdfjsLib.getDocument({ data: bytes }).promise;
}

describe('real PDF fixture: numeric-tempo-only section titles (Finding 2 + the numeric-tempo-gate fix)', () => {
  // A synthetic 3-page "combined score + parts" PDF, mirroring the real bug
  // shape found on a real "Score and Parts"-style file:
  //   page 1 (bootstrap): lists a full name once beside system 0
  //     ("Clarinet in B 1", "Bass Clarinet"), then an ABBREVIATED label
  //     further down ("B Cl. 1") standing in for a later system on the same
  //     page -- title-block text ("Score") sits above it all. No Italian
  //     tempo word anywhere in this whole document, only numeric marks.
  //   page 2: a genuine new part's title page -- "Bass Clarinet" (its FULL
  //     name) at the left margin plus a bare "= 127" mark, no word. Must be
  //     detected as a real section boundary.
  //   page 3: a Score CONTINUATION page -- same numeric tempo mark restated,
  //     plus the instrument's ABBREVIATED label ("B Cl. 1") at the left
  //     margin (as it legitimately is on every page) -- must NOT be
  //     detected as a new section (the real Finding 2 bug: this used to
  //     false-trigger before the isFull tagging fix).
  let pages; // [{ items, rows }] per page, from the REAL extracted text layer

  beforeAll(async () => {
    const doc = await PDFDocument.create();

    const p1 = doc.addPage([612, 792]);
    p1.drawText('Score', { x: 90, y: 750, size: 12 });                 // title block, above system 0
    p1.drawText('Clarinet in B 1', { x: 39, y: 700, size: 10 });        // system 0's own full name
    p1.drawText('Bass Clarinet', { x: 39, y: 670, size: 10 });          // system 0's own full name (2nd staff)
    p1.drawText('B Cl. 1', { x: 39, y: 600, size: 10 });                // a LATER system's abbreviated label
    p1.drawText('= 127', { x: 300, y: 700, size: 10 });                 // numeric tempo mark, never a word

    const p2 = doc.addPage([612, 792]);
    p2.drawText('Bass Clarinet', { x: 39, y: 700, size: 10 });          // this part's own FULL name
    p2.drawText('= 127', { x: 60, y: 710, size: 10 });                  // its opening tempo mark
    p2.drawText('My Piece', { x: 216, y: 739, size: 10 });              // unrelated title text, off the margin

    const p3 = doc.addPage([612, 792]);
    p3.drawText('B Cl. 1', { x: 39, y: 700, size: 10 });                // Score's own running abbreviated label
    p3.drawText('= 127', { x: 60, y: 710, size: 10 });                  // restated on every page of the Score

    const bytes = await doc.save();
    const pdf = await loadPdf(bytes);
    pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const items = toPlainItems(content);
      pages.push({ items, rows: groupIntoRows(items) });
    }
  });

  it('parsed all 3 pages of a real PDF via pdfjs (sanity: the fixture itself is genuine)', () => {
    expect(pages).toHaveLength(3);
    expect(pages[0].items.some((it) => it.str === 'Clarinet in B 1')).toBe(true);
  });

  it('collects both full names (isFull) and the abbreviated label (not isFull) from the real page-1 text layer', () => {
    // Synthetic system-0 band standing in for the pixel pass (see file
    // header) -- chosen to span the two real full-name rows (700, 670)
    // while excluding the abbreviated one drawn at 600.
    const firstSystem = { yTop: 705, yBottom: 650 };
    const names = collectKnownNames(pages[0].rows, firstSystem);
    expect(names).toEqual([
      { text: 'Clarinet in B 1', isFull: true },
      { text: 'Bass Clarinet', isFull: true },
      { text: 'B Cl. 1', isFull: false },
    ]);
  });

  it('detects page 2 as a real new-part title page from a bare numeric tempo mark alone (no Italian word anywhere in the fixture)', () => {
    const firstSystem = { yTop: 705, yBottom: 650 };
    const knownNames = collectKnownNames(pages[0].rows, firstSystem);
    const title = findSectionTitle(pages[1].items, pages[1].rows, knownNames);
    expect(title).toBe('Bass Clarinet');
  });

  it('does NOT flag page 3 (a Score continuation page) even though it also has a numeric tempo mark and a known-name match (Finding 2)', () => {
    const firstSystem = { yTop: 705, yBottom: 650 };
    const knownNames = collectKnownNames(pages[0].rows, firstSystem);
    const title = findSectionTitle(pages[2].items, pages[2].rows, knownNames);
    expect(title).toBeNull();
  });
});

describe('real PDF fixture: measure-number reset with no combined-score bootstrap page', () => {
  // Two individual-part-style pages with no shared "Score" page at all (the
  // real "Full band arrangements"-style case) -- page 2's printed measure
  // numbers restart at 1, which must be detectable purely from the real
  // extracted digit text, with no instrument name involved at all.
  let pages;

  beforeAll(async () => {
    const doc = await PDFDocument.create();

    const p1 = doc.addPage([612, 792]);
    p1.drawText('9', { x: 37, y: 700, size: 9 });    // measure number above system 0

    const p2 = doc.addPage([612, 792]);
    p2.drawText('1', { x: 37, y: 700, size: 9 });     // a new part restarts at measure 1
    p2.drawText('5', { x: 37, y: 600, size: 9 });     // and keeps climbing, confirming the restart

    const bytes = await doc.save();
    const pdf = await loadPdf(bytes);
    pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(toPlainItems(content));
    }
  });

  it('reads the real printed numbers via extractMeasureNumbers and finds the reset via detectMeasureNumberResets', () => {
    // Synthetic per-page system bands standing in for the pixel pass (see
    // file header) -- one system per page, positioned so each page's real
    // printed number correlates to it (extractMeasureNumbers' own pad=20
    // tolerance covers the small gap between the drawn text's y and yTop).
    const system0 = [{ index: 0, yTop: 705, yBottom: 650 }];
    const system1 = [{ index: 1, yTop: 705, yBottom: 650 }];
    const system2 = [{ index: 2, yTop: 605, yBottom: 550 }];

    const entries = [
      ...extractMeasureNumbers(pages[0], system0),
      ...extractMeasureNumbers(pages[1], system1),
      ...extractMeasureNumbers(pages[1], system2),
    ];
    expect(entries).toEqual([
      { systemIndex: 0, measureNumber: 9 },
      { systemIndex: 1, measureNumber: 1 },
      { systemIndex: 2, measureNumber: 5 },
    ]);
    expect(detectMeasureNumberResets(entries)).toEqual([1]); // system 1 is where the new part starts
  });
});

describe('real PDF fixture: a page whose declared /Rotate flag is wrong for its content', () => {
  // Confirms pdfjs-dist genuinely reads a wrong-but-declared /Rotate flag
  // back exactly as written on a real (if minimal) PDF -- the actual
  // per-orientation ink-scoring correction itself (probePageRotation /
  // scoreOrientation in lib/pageRotation.js) needs page.render() to a
  // canvas to test end-to-end, which this project deliberately doesn't add
  // (see file header) -- that logic is already unit-tested directly against
  // synthetic ink functions in pageRotation.test.js. What's worth confirming
  // here, with a real file, is the one fact those pure-function tests can't
  // reach on their own: that a real PDF's OWN declared rotation reads back
  // through the real pdfjs API exactly as written, independent of its
  // content -- the actual real-world condition (a portrait page's content
  // paired with a wrong declared rotation) that motivated the whole fix.
  it('reads back exactly the declared rotation, regardless of the page content drawn on it', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]); // a plain portrait page...
    page.drawText('Clarinet in B 1', { x: 39, y: 700, size: 10 });
    page.setRotation(degrees(270));       // ...wrongly declared as landscape/rotated

    const bytes = await doc.save();
    const pdf = await loadPdf(bytes);
    const pdfPage = await pdf.getPage(1);
    expect(pdfPage.rotate).toBe(270);
    // getViewport({ rotation: 0 }) OVERRIDES the declared rotation (this is
    // exactly the mechanism probePageRotation relies on to render candidate
    // orientations) -- confirms a caller can always ask for a specific
    // rotation regardless of what's declared.
    const declaredVp = pdfPage.getViewport({ scale: 1 });
    const overriddenVp = pdfPage.getViewport({ scale: 1, rotation: 0 });
    expect([declaredVp.width, declaredVp.height]).toEqual([792, 612]); // swapped (270 is a "landscape" rotation)
    expect([overriddenVp.width, overriddenVp.height]).toEqual([612, 792]); // the page's real, un-rotated portrait shape
  });
});
