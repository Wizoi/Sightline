// Drives one real PDF through the actual running app (via a Playwright
// `page` already navigated to the app's base URL) and extracts exactly the
// DOM-visible outputs the benchmark scores against. Deliberately reads only
// what a real user/screen would show (element text/values) -- no reaching
// into module state -- both because that's what the brief asked for and
// because it's the more honest thing to score against: if a real signal
// isn't surfaced in the DOM, the benchmark shouldn't be able to see it
// either.
//
// Section-name suffix format this parses (see src/autoScrollUI.js's
// renderSectionsList()):
//   "<name> (<N> systems)"
//   "<name> — auto-detected split (<N> systems)"
const SECTION_OPTION_RE = /^(.*?)(?: — auto-detected split)? \(\d+ systems\)$/;

function parseSectionOptionText(text) {
  const m = SECTION_OPTION_RE.exec(text.trim());
  return m ? m[1] : text.trim();
}

// Extracts the ♩=N sequence out of #autoScrollTempoInfo's text (see
// lib/tempoSchedule.js's tempoSequence() / autoScrollUI.js's
// refreshTempoInfo()) -- empty string/no marks both correctly yield [].
function parseTempoInfoBpms(text) {
  return [...text.matchAll(/♩\s*=\s*(\d+)/g)].map((m) => parseInt(m[1], 10));
}

// #autoScrollTempoInfo is DELIBERATELY left blank for a flat, single tempo
// (see autoScrollUI.js's refreshTempoInfo(): "A single tempo ... shows
// nothing -- the slider behaves exactly as it always has") -- it only ever
// shows text when a piece has 2+ distinct tempos. Reading only that banner
// therefore reports `[]` (indistinguishable from "no tempo detected at all")
// for the very common single-flat-tempo case, even when the app correctly
// detected and adopted a real printed tempo -- confirmed as a real gap on
// this benchmark's first run (every single-tempo anime/solo-clarinet file in
// the corpus scored bpmAccuracy=0 despite the app visibly setting the right
// tempo). The single real detected tempo, when there is one, IS surfaced
// elsewhere: `#bpmV`'s text (`"<n> bpm"`) reflects `state.autoScroll.bpm`,
// which analyzeScore() sets to the piece's own opening printed tempo when
// any mark was found at all (see scoreAnalysis.js), or leaves at whatever it
// already was (the manual slider's own prior/default value) when none was.
// Comparing against a BASELINE captured before this file was even loaded
// (rather than assuming a specific hardcoded default number) is what lets
// this tell "a real tempo was detected and is just being displayed via the
// slider, not the banner" apart from "nothing was detected, the slider is
// just sitting at whatever it started this session at".
function parseBpmV(text) {
  const m = /^(\d+)\s*bpm$/.exec(text.trim());
  return m ? parseInt(m[1], 10) : null;
}

// Reads one element's property/text via $eval, but tolerates the element not
// existing at all -- needed for backfill.mjs, which drives arbitrarily OLD
// historical commits through this SAME, current-DOM-shaped driver. A commit
// from before a given element existed (confirmed real: #autoScrollTempoInfo
// was added in a later commit than two of backfill.mjs's own candidate
// commits, `49c66a4`/`89bab60` -- both predate it entirely, and `49c66a4`
// also predates #sectionsSelect existing at all, since the Sections picker
// was originally per-row text inputs, not a dropdown, until a later commit)
// would otherwise throw on page.$eval and fail that WHOLE file's analysis,
// discarding even the parts of the DOM (like #autoScrollSummary's system
// count, confirmed present since `49c66a4`) that genuinely did exist and are
// real, comparable data for that historical point. Returns `fallback` (never
// throws) when the selector doesn't match anything.
async function safeEval(page, selector, fn, fallback) {
  const handle = await page.$(selector);
  if (!handle) return fallback;
  return page.$eval(selector, fn);
}

// Builds the URL a caller should page.goto() to when it wants
// analyzeScore()'s dev/benchmark-only forceOcr override active for
// everything analyzed on that page (see scoreAnalysis.js's
// isForceOcrRequested() doc comment for what this does and doesn't affect) --
// used by run-ocr-validation.mjs, not by the normal run.mjs accuracy
// benchmark.
export function withForceOcr(baseUrl) {
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}forceOcr=1`;
}

async function ensureMeasuresListExpanded(page) {
  const isOpen = await page.$eval('#measuresDetails', (el) => el.open);
  if (!isOpen) await page.click('#measuresDetails summary');
}

async function readMeasuresList(page) {
  await ensureMeasuresListExpanded(page);
  return page.$$eval('#measuresList input', (inputs) => inputs.map((i) => parseInt(i.value, 10)));
}

// Loads one PDF through the real UI (#file input -> the app's own onchange
// handler -> loadPdf()/renderAll()), runs Analyze, and reads back every
// signal this benchmark scores. `page` should be a fresh navigation (this
// module assumes a clean state.autoScroll -- callers reload the app between
// files rather than reusing one loaded document's leftover state).
export async function analyzeFile(page, absolutePdfPath, { loadTimeoutMs = 180000, analyzeTimeoutMs = 600000 } = {}) {
  // Captured BEFORE loading this file -- see parseBpmV()'s own doc comment
  // for why this baseline (not an assumed hardcoded default) is what lets a
  // real single detected tempo be told apart from "nothing detected, the
  // slider's untouched starting value."
  const bpmVBaseline = await safeEval(page, '#bpmV', (el) => el.textContent, null);

  await page.setInputFiles('#file', absolutePdfPath);

  // loadPdf() hides #empty only after renderAll() has finished rendering
  // every page -- see src/pdf.js. That's the honest "the PDF is loaded and
  // on screen" signal, not just "the file was read."
  await page.waitForFunction(
    () => document.getElementById('empty').style.display === 'none',
    undefined,
    { timeout: loadTimeoutMs },
  );

  await page.click('#tabAutoScroll');
  await page.click('#analyzeScoreBtn');

  // analyzeScore() disables the button for its own duration (see
  // autoScrollUI.js) then, only once the whole analysis + any resulting
  // renderAll() + renderSummary() have run, sets #autoScrollSummary's text.
  // Waiting on the summary text directly (rather than just the button's
  // disabled state) is what actually guarantees renderSummary() -- and
  // therefore the sections list / measures list / tempo info this driver
  // reads next -- has finished, since the button flips back to enabled
  // slightly BEFORE those run (see the try/finally in autoScrollUI.js).
  await page.waitForFunction(
    () => {
      const el = document.getElementById('autoScrollSummary');
      return !!el && el.textContent.trim().length > 0;
    },
    undefined,
    { timeout: analyzeTimeoutMs },
  );

  const summaryText = await page.$eval('#autoScrollSummary', (el) => el.textContent);
  const summaryMatch = /Found (\d+) systems/.exec(summaryText);
  const systemCount = summaryMatch ? parseInt(summaryMatch[1], 10) : 0;
  const usedOcr = /No embedded text/.test(summaryText);

  // Defaults to "hidden" (the single-section case) when #sectionsBox itself
  // doesn't exist on this historical commit -- the safest assumption, since
  // it's this driver's own already-established DOM-equivalent of "one
  // section, nothing to split" (see the comment on the `else` branch below).
  const sectionsHidden = await safeEval(page, '#sectionsBox', (el) => el.classList.contains('hidden'), true);

  let sectionNames = [];
  let measuresPerSystem = [];
  let tempoBpms = [];

  // #sectionsSelect not existing at all (a historical commit whose Sections
  // picker was per-row text inputs, not yet a dropdown -- confirmed real on
  // this project's own `49c66a4`) falls through to the single-section branch
  // below rather than throwing -- this file's multi-section data is simply
  // not recoverable from that historical UI shape, but its system count
  // still is.
  const hasSectionsSelect = !sectionsHidden && (await page.$('#sectionsSelect')) != null;

  if (hasSectionsSelect) {
    const optionTexts = await page.$$eval('#sectionsSelect option', (opts) => opts.map((o) => o.textContent));
    sectionNames = optionTexts.map(parseSectionOptionText);

    // Multi-section files only ever show the ACTIVE section's own
    // measuresPerSystem/tempo info at once (see autoScrollUI.js's
    // selectSection()/refreshTempoInfo() doc comments) -- so the
    // whole-document arrays this benchmark compares against ground truth
    // are built by selecting each section in turn (already in document
    // order in the dropdown) and concatenating what it shows.
    for (let i = 0; i < optionTexts.length; i++) {
      await page.selectOption('#sectionsSelect', String(i));
      const sectionMeasures = await readMeasuresList(page);
      measuresPerSystem.push(...sectionMeasures);

      const tempoText = await safeEval(page, '#autoScrollTempoInfo', (el) => el.textContent, '');
      let sectionBpms = parseTempoInfoBpms(tempoText);
      // Only the FIRST section's flat-tempo fallback is unambiguous against
      // the pre-load baseline (see parseBpmV()'s doc comment) -- a LATER
      // section's own #bpmV correctly shows its carried-forward tempo
      // whenever ANY mark exists anywhere earlier in the document, which is
      // indistinguishable from "coincidentally still at the baseline" using
      // this same trick, so this fallback is deliberately scoped to i === 0.
      if (sectionBpms.length === 0 && i === 0) {
        const bpmVText = await safeEval(page, '#bpmV', (el) => el.textContent, bpmVBaseline);
        if (bpmVText !== bpmVBaseline) {
          const single = parseBpmV(bpmVText);
          if (single != null) sectionBpms = [single];
        }
      }
      // Collapse a duplicate value at the section seam (e.g. section i ends
      // on ♩=120 and section i+1's carried-in tempo is still 120) -- each
      // section's OWN sequence already collapses consecutive-equal values
      // (see tempoSchedule.js's tempoSequence()), so the only place a
      // duplicate can appear is exactly at this boundary.
      for (const bpm of sectionBpms) {
        if (tempoBpms[tempoBpms.length - 1] !== bpm) tempoBpms.push(bpm);
      }
    }
  } else {
    // #sectionsBox stays hidden whenever the app only ever built ONE section
    // (see autoScrollUI.js's renderSummary()/buildSections() -- "a single
    // section is by far the common case ... the picker stays hidden and
    // nothing about the UI changes"). That one section is always internally
    // named "Score" (buildSections()'s `i === 0 ? 'Score' : ...` fallback),
    // regardless of whether the dropdown that would otherwise show it is
    // visible -- and ground truth uses that same "Score" convention for an
    // ordinary single-section file's one entry (see groundTruth.mjs). So the
    // honest DOM-visible equivalent of "the app detected exactly one
    // section, and didn't find any further split" is `['Score']`, not `[]` --
    // scoring it as `[]` would wrongly fail a perfectly-correct
    // single-section file's name accuracy, and would under-penalize a
    // genuinely multi-section file the app failed to split at all (both
    // look identical from the DOM alone: a hidden sectionsBox).
    sectionNames = ['Score'];
    measuresPerSystem = await readMeasuresList(page);
    const tempoText = await safeEval(page, '#autoScrollTempoInfo', (el) => el.textContent, '');
    tempoBpms = parseTempoInfoBpms(tempoText);
    if (tempoBpms.length === 0) {
      const bpmVText = await safeEval(page, '#bpmV', (el) => el.textContent, bpmVBaseline);
      if (bpmVText !== bpmVBaseline) {
        const single = parseBpmV(bpmVText);
        if (single != null) tempoBpms = [single];
      }
    }
  }

  return { systemCount, usedOcr, sectionNames, measuresPerSystem, tempoBpms };
}
