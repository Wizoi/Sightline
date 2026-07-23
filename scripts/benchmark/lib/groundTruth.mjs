// Loads benchmarks/ground-truth/*.json.
//
// Ground-truth file schema (one JSON file per scored PDF) -- matches the
// real format the corpus-labeling agents are independently producing (see
// two real examples already checked in under benchmarks/ground-truth/ as of
// this writing), NOT an independently-invented schema:
//   {
//     "file": "Some Folder/SomeFile.pdf",       // path RELATIVE to the
//                                                // corpus root
//     "pageCount": 2,                           // informational only, not
//                                                // scored by run.mjs
//     "sections": [                             // ordered, document order
//       { "name": "Score", "startPage": 1, "isGeneric": true },
//       { "name": "Clarinet in B", "startPage": 2, "isGeneric": false }
//     ],
//     "totalSystems": 7,                        // whole-document total
//     "measuresPerSystem": [6, 6, 6, 5, 5, 4, 4],// whole-document, one entry
//                                                // per system, length ===
//                                                // totalSystems
//     "tempoMarks": [],                         // ordered sequence of
//                                                // DISTINCT printed tempo
//                                                // values expected across
//                                                // the whole document, in
//                                                // order (empty for a flat,
//                                                // single-tempo piece) --
//                                                // tolerant of either plain
//                                                // numbers or {bpm: N}-
//                                                // shaped objects, see
//                                                // normalizeTempoMarks()
//                                                // below
//     "timeSignature": "6/8"                    // informational only, not
//                                                // scored by run.mjs (no
//                                                // beats-per-measure/note-
//                                                // value dimension in this
//                                                // benchmark yet)
//   }
// A single-section (the overwhelmingly common case -- this app's primary
// audience is single-staff band parts) file's `sections` is just
// `[{ "name": "Score", ... }]` -- see appDriver.mjs's own doc comment on why
// the app's hidden-sections-dropdown case is scored against exactly that.
//
// `meta.json`, if present, is corpus-level configuration, not a scored file
// -- skipped here. Its only currently-recognized key is `corpusRoot`
// (absolute path the `file` fields above are relative to), used only when
// neither --corpus-root nor CORPUS_ROOT overrides it -- see run.mjs.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function loadMeta(groundTruthDir) {
  const metaPath = path.join(groundTruthDir, 'meta.json');
  if (!existsSync(metaPath)) return {};
  return JSON.parse(readFileSync(metaPath, 'utf8'));
}

// Ground truth's tempoMarks entries could plausibly be recorded as either
// plain bpm numbers or richer {bpm, ...} objects -- normalize to plain
// numbers either way rather than assuming one shape and breaking the day the
// labeling agents add more detail to it.
function normalizeTempoMarks(marks) {
  return (marks ?? []).map((m) => (typeof m === 'object' && m !== null ? m.bpm : m));
}

export function loadGroundTruths(groundTruthDir) {
  if (!existsSync(groundTruthDir)) {
    throw new Error(`Ground-truth directory not found: ${groundTruthDir}`);
  }
  const files = readdirSync(groundTruthDir)
    .filter((f) => f.endsWith('.json') && f !== 'meta.json')
    .sort();

  return files.map((f) => {
    const full = path.join(groundTruthDir, f);
    let gt;
    try {
      gt = JSON.parse(readFileSync(full, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse ground-truth file ${full}: ${err.message}`);
    }
    if (!gt.file) throw new Error(`Ground-truth file ${full} is missing required "file" field`);
    return {
      sourcePath: full,
      file: gt.file,
      sectionNames: (gt.sections ?? []).map((s) => s.name),
      systemCount: gt.totalSystems ?? 0,
      measuresPerSystem: gt.measuresPerSystem ?? [],
      tempoBpms: normalizeTempoMarks(gt.tempoMarks),
    };
  });
}
