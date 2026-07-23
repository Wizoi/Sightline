#!/usr/bin/env node
// Prints a trend table across every committed benchmark snapshot
// (benchmarks/snapshots/*.json, see run.mjs), sorted by the commit each
// snapshot was tagged with -- so accuracy can be read as a trend over the
// feature's real history, not just a single point-in-time run. No
// dependencies beyond what's already in the project (plain fs/path).

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SNAPSHOTS_DIR = path.join(REPO_ROOT, 'benchmarks', 'snapshots');

// "80.6±24.3" -- compact (no % signs, no spaces around ±) so the trend
// table's columns stay a readable width across 4 metrics x 6+ snapshots. See
// scoring.mjs's stddev() for why this is worth showing at all: this corpus
// is bimodal (roughly half the files are simple pieces that always score
// ~100%, the rest are hard files with real spread), so a stable-looking mean
// can hide real per-file movement in both directions underneath it -- a wide
// spread next to the mean is the tell that the per-file breakdown is worth
// checking for that row.
function pctSpread(meanVal, stddevVal, n) {
  if (meanVal == null) return 'n/a';
  const meanStr = (meanVal * 100).toFixed(1);
  return n > 1 ? `${meanStr}±${(stddevVal * 100).toFixed(1)}` : meanStr;
}

function loadSnapshots() {
  let files;
  try {
    files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => JSON.parse(readFileSync(path.join(SNAPSHOTS_DIR, f), 'utf8')))
    .sort((a, b) => new Date(a.commitDate) - new Date(b.commitDate));
}

function pad(str, width) {
  str = String(str);
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

// Prints one trend table for a single group's numbers ("overall",
// "textLayer", or "ocr" -- see run.mjs's summarize()/summarizeGroup()) across
// every snapshot. Text-layer and OCR-fallback PDFs are different accuracy
// regimes (real embedded numbers vs. a scan read through tesseract.js), so a
// blended "overall" number alone would hide exactly the split that matters
// for deciding where detection work should focus next -- see this file's own
// three calls to this function in main().
function printGroupTable(label, snapshots, groupKey) {
  console.log(`\n=== ${label} (mean ± population stddev across files) ===`);
  const cols = [
    ['Date', 12], ['Commit', 9], ['Files', 7],
    ['SysCount', 13], ['SecName', 13], ['Measures', 13], ['BPM', 13],
  ];
  console.log(cols.map(([name, w]) => pad(name, w)).join(' '));
  console.log(cols.map(([, w]) => '-'.repeat(w)).join(' '));

  for (const snap of snapshots) {
    const g = (snap.summary && snap.summary[groupKey]) || {};
    const row = [
      pad(new Date(snap.commitDate).toISOString().slice(0, 10), 12),
      pad((snap.commitHash || '').slice(0, 7), 9),
      pad(g.scoredFiles ?? '?', 7),
      pad(pctSpread(g.meanSystemCountAccuracy, g.stddevSystemCountAccuracy, g.scoredFiles), 13),
      pad(pctSpread(g.meanSectionNameAccuracy, g.stddevSectionNameAccuracy, g.scoredFiles), 13),
      pad(pctSpread(g.meanMeasuresPerSystemAccuracy, g.stddevMeasuresPerSystemAccuracy, g.measuresPerSystemComparableFiles), 13),
      pad(pctSpread(g.meanBpmAccuracy, g.stddevBpmAccuracy, g.scoredFiles), 13),
    ];
    console.log(row.join(' '));
  }
}

function main() {
  const snapshots = loadSnapshots();
  if (snapshots.length === 0) {
    console.log(`No snapshots found in ${SNAPSHOTS_DIR} -- run scripts/benchmark/run.mjs first.`);
    return;
  }

  printGroupTable('Overall', snapshots, 'overall');
  printGroupTable('Text-layer PDFs', snapshots, 'textLayer');
  printGroupTable('Scanned/OCR PDFs', snapshots, 'ocr');
}

main();
