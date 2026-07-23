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

function pct(x) {
  return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
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
  console.log(`\n=== ${label} ===`);
  const cols = [
    ['Date', 12], ['Commit', 9], ['Files', 7],
    ['SysCount', 9], ['SecName', 9], ['Measures', 9], ['BPM', 9],
  ];
  console.log(cols.map(([name, w]) => pad(name, w)).join(' '));
  console.log(cols.map(([, w]) => '-'.repeat(w)).join(' '));

  for (const snap of snapshots) {
    const g = (snap.summary && snap.summary[groupKey]) || {};
    const row = [
      pad(new Date(snap.commitDate).toISOString().slice(0, 10), 12),
      pad((snap.commitHash || '').slice(0, 7), 9),
      pad(g.scoredFiles ?? '?', 7),
      pad(pct(g.meanSystemCountAccuracy), 9),
      pad(pct(g.meanSectionNameAccuracy), 9),
      pad(pct(g.meanMeasuresPerSystemAccuracy), 9),
      pad(pct(g.meanBpmAccuracy), 9),
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
