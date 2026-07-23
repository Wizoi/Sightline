#!/usr/bin/env node
// Committed, repeatable Analyze-score accuracy benchmark runner -- the
// permanent replacement for this feature's prior "ad hoc, session-only
// Playwright sweep" verification pattern (see docs/PERSONAS.md sections 3
// and 8). Loads every real PDF referenced by benchmarks/ground-truth/*.json
// through the actual running app, diffs the DOM-visible Analyze results
// against ground truth, and writes one dated/commit-tagged snapshot under
// benchmarks/snapshots/.
//
// Usage:
//   node scripts/benchmark/run.mjs [options]
//
// Options (all optional):
//   --port <n>              connect to an ALREADY-RUNNING dev server on this
//                            port instead of starting a new one (used by
//                            backfill.mjs, which starts its own per-worktree
//                            server before delegating here)
//   --base-url <url>        full base URL override (implies --port's effect;
//                            takes precedence over --port if both given)
//   --cwd <dir>             directory to run "npm run dev" in if this script
//                            starts its own server (default: repo root)
//   --ground-truth-dir <d>  default: <repo root>/benchmarks/ground-truth
//   --corpus-root <dir>     root the ground-truth "file" fields are relative
//                            to (default: meta.json's corpusRoot, else the
//                            CORPUS_ROOT env var, else a hardcoded fallback)
//   --out <path>            snapshot output path override (backfill.mjs uses
//                            this to tag a snapshot with the HISTORICAL
//                            commit's date instead of today's)
//   --commit-hash <hash>    record this commit hash in the snapshot instead
//                            of reading it from `git log` in --cwd
//   --commit-date <iso>     record this commit date in the snapshot instead
//                            of reading it from `git log` in --cwd
//   --headed                run the browser headed (debugging convenience)
//   --load-timeout <ms>     per-file PDF-load timeout (default 180000)
//   --analyze-timeout <ms>  per-file Analyze-score timeout (default 600000 --
//                            OCR fallback on a many-page scanned booklet can
//                            genuinely take minutes)
//
// See scripts/benchmark/lib/groundTruth.mjs for the ground-truth JSON schema.

import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDevServer } from './lib/devServer.mjs';
import { loadGroundTruths, loadMeta } from './lib/groundTruth.mjs';
import { analyzeFile } from './lib/appDriver.mjs';
import {
  sectionNameAccuracy, systemCountAccuracy, measuresPerSystemAccuracy, bpmAccuracy,
} from './lib/scoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const DEFAULT_CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEFAULT_CORPUS_ROOT = 'C:\\Users\\kidzi\\OneDrive\\Desktop\\sheetmusic';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'headed') { args[key] = true; continue; }
    args[key] = argv[++i];
  }
  return args;
}

function gitInfo(cwd) {
  const raw = execSync('git log -1 --format=%H,%cI', { cwd, encoding: 'utf8' }).trim();
  const [hash, date] = raw.split(',');
  return { hash, date };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const cwd = args.cwd ? path.resolve(args.cwd) : REPO_ROOT;
  const groundTruthDir = args['ground-truth-dir']
    ? path.resolve(args['ground-truth-dir'])
    : path.join(REPO_ROOT, 'benchmarks', 'ground-truth');
  const meta = loadMeta(groundTruthDir);
  const corpusRoot = args['corpus-root'] || process.env.CORPUS_ROOT || meta.corpusRoot || DEFAULT_CORPUS_ROOT;
  const chromePath = process.env.CHROME_PATH || DEFAULT_CHROME_PATH;
  const loadTimeoutMs = args['load-timeout'] ? parseInt(args['load-timeout'], 10) : 180000;
  const analyzeTimeoutMs = args['analyze-timeout'] ? parseInt(args['analyze-timeout'], 10) : 600000;

  const groundTruths = loadGroundTruths(groundTruthDir);
  if (groundTruths.length === 0) {
    console.log(`No ground-truth files found in ${groundTruthDir} -- nothing to run.`);
    return;
  }

  const { hash: commitHash, date: commitDate } = args['commit-hash']
    ? { hash: args['commit-hash'], date: args['commit-date'] || new Date().toISOString() }
    : gitInfo(cwd);

  // Start (or connect to) the dev server this benchmark drives against.
  let devServer = null;
  let baseUrl = args['base-url'];
  if (!baseUrl) {
    if (args.port) {
      baseUrl = `http://localhost:${args.port}`;
    } else {
      console.log(`Starting dev server in ${cwd}...`);
      devServer = await startDevServer(cwd, { readyTimeoutMs: 120000 });
      baseUrl = devServer.baseUrl;
      console.log(`Dev server ready at ${baseUrl}`);
    }
  }

  const browser = await chromium.launch({ executablePath: chromePath, headless: !args.headed });
  const perFile = [];

  try {
    for (const gt of groundTruths) {
      const pdfPath = path.isAbsolute(gt.file) ? gt.file : path.join(corpusRoot, gt.file);
      if (!existsSync(pdfPath)) {
        console.warn(`SKIP ${gt.file}: not found at ${pdfPath}`);
        perFile.push({ file: gt.file, error: `PDF not found at ${pdfPath}` });
        continue;
      }

      console.log(`Analyzing ${gt.file}...`);
      const page = await browser.newPage();
      try {
        await page.goto(baseUrl, { waitUntil: 'load' });
        const app = await analyzeFile(page, pdfPath, { loadTimeoutMs, analyzeTimeoutMs });
        perFile.push(scoreFile(gt, app));
      } catch (err) {
        console.warn(`ERROR analyzing ${gt.file}: ${err.message}`);
        perFile.push({ file: gt.file, error: err.message });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    if (devServer) await devServer.stop();
  }

  const summary = summarize(perFile);
  const snapshot = { commitHash, commitDate, runDate: new Date().toISOString(), perFile, summary };

  const outPath = args.out
    ? path.resolve(args.out)
    : defaultSnapshotPath(REPO_ROOT, commitDate, commitHash);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\nWrote snapshot: ${outPath}`);
  printSummary(summary);
}

function defaultSnapshotPath(repoRoot, commitDate, commitHash) {
  const day = new Date(commitDate).toISOString().slice(0, 10);
  const shortSha = commitHash.slice(0, 7);
  return path.join(repoRoot, 'benchmarks', 'snapshots', `${day}-${shortSha}.json`);
}

// Diffs one file's ground truth against what the app actually reported.
// See run.mjs's module doc + the OMR-persona brief's "Alignment note" for
// why measures-per-system is only scored when the app's total system count
// matches ground truth -- with a different count, index-by-index alignment
// between the two arrays no longer corresponds to the same real systems, so
// computing a number there would be misleading rather than merely
// approximate.
function scoreFile(gt, app) {
  const systemCountAcc = systemCountAccuracy(app.systemCount, gt.systemCount);
  const sectionNameAcc = sectionNameAccuracy(gt.sectionNames, app.sectionNames);
  const bpm = bpmAccuracy(gt.tempoBpms, app.tempoBpms);

  const countsMatch = app.systemCount === gt.systemCount;
  const measures = countsMatch ? measuresPerSystemAccuracy(gt.measuresPerSystem, app.measuresPerSystem) : null;

  return {
    file: gt.file,
    truth: {
      systemCount: gt.systemCount, sectionNames: gt.sectionNames,
      measuresPerSystem: gt.measuresPerSystem, tempoBpms: gt.tempoBpms,
    },
    app: {
      systemCount: app.systemCount, sectionNames: app.sectionNames,
      measuresPerSystem: app.measuresPerSystem, tempoBpms: app.tempoBpms, usedOcr: app.usedOcr,
    },
    systemCountAccuracy: systemCountAcc,
    sectionNameAccuracy: sectionNameAcc,
    measuresPerSystemComparable: countsMatch,
    measuresPerSystemAccuracy: measures ? measures.fraction : null,
    measuresPerSystemMeanAbsError: measures ? measures.meanAbsError : null,
    bpmAccuracy: bpm.fraction,
    bpmSpuriousCount: bpm.spuriousCount,
  };
}

function mean(nums) {
  const vals = nums.filter((n) => n != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// Summarizes one GROUP of already-scored files (a plain array, no `.error`
// entries) into the aggregate numbers printed/stored. Split out from
// `summarize()` below so the same math can run once for "all files," once
// for "text-layer files only," and once for "scanned/OCR files only" --
// text-layer vs. OCR-fallback PDFs are different accuracy regimes (a clean
// vector PDF's real embedded numbers vs. a scan read through tesseract.js),
// so blending them into one mean was hiding exactly the distinction that
// matters for deciding where detection work should focus next.
function summarizeGroup(scoredGroup) {
  const measuresComparable = scoredGroup.filter((f) => f.measuresPerSystemComparable);
  return {
    scoredFiles: scoredGroup.length,
    meanSystemCountAccuracy: mean(scoredGroup.map((f) => f.systemCountAccuracy)),
    meanSectionNameAccuracy: mean(scoredGroup.map((f) => f.sectionNameAccuracy)),
    measuresPerSystemComparableFiles: measuresComparable.length,
    meanMeasuresPerSystemAccuracy: mean(measuresComparable.map((f) => f.measuresPerSystemAccuracy)),
    meanMeasuresPerSystemMeanAbsError: mean(measuresComparable.map((f) => f.measuresPerSystemMeanAbsError)),
    meanBpmAccuracy: mean(scoredGroup.map((f) => f.bpmAccuracy)),
    totalBpmSpuriousCount: scoredGroup.reduce((a, f) => a + (f.bpmSpuriousCount || 0), 0),
  };
}

function summarize(perFile) {
  const scored = perFile.filter((f) => !f.error);
  const textLayer = scored.filter((f) => !f.app.usedOcr);
  const ocr = scored.filter((f) => f.app.usedOcr);
  return {
    totalFiles: perFile.length,
    scoredFiles: scored.length,
    erroredFiles: perFile.length - scored.length,
    overall: summarizeGroup(scored),
    textLayer: summarizeGroup(textLayer),
    ocr: summarizeGroup(ocr),
  };
}

function pct(x) {
  return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

function printGroupSummary(label, s) {
  console.log(`\n-- ${label} (${s.scoredFiles} files) --`);
  console.log(`System count accuracy:      ${pct(s.meanSystemCountAccuracy)}`);
  console.log(`Section name accuracy:      ${pct(s.meanSectionNameAccuracy)}`);
  console.log(`Measures/system accuracy:   ${pct(s.meanMeasuresPerSystemAccuracy)} (MAE ${s.meanMeasuresPerSystemMeanAbsError ?? 'n/a'}, ${s.measuresPerSystemComparableFiles}/${s.scoredFiles} files comparable)`);
  console.log(`BPM sequence accuracy:      ${pct(s.meanBpmAccuracy)} (${s.totalBpmSpuriousCount} total spurious values)`);
}

function printSummary(s) {
  console.log(`\nFiles: ${s.scoredFiles}/${s.totalFiles} scored (${s.erroredFiles} errored)`);
  printGroupSummary('Overall', s.overall);
  printGroupSummary('Text-layer PDFs', s.textLayer);
  printGroupSummary('Scanned/OCR PDFs', s.ocr);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
