#!/usr/bin/env node
// OCR-only validation pass -- a SEPARATE, synthetic "what if" probe, not a
// normal per-commit accuracy trend measurement (that's run.mjs/report.mjs).
//
// Motivation (see docs/PERSONAS.md section 3 and the brief this was built
// from): normally OCR (ocrPageNumbers() in src/scoreAnalysis.js) only ever
// runs on scanned/image-only PDFs, where this project's ground truth is
// itself lower-confidence (scan quality affects how confidently a human can
// verify the "true" measure numbers too -- see the Lazarus/KingCotton
// ground-truth files' own confidence caveats). Text-layer PDFs give a chance
// to measure "how good is OCR alone at reading printed measure numbers" using
// numbers we're much more confident about, by deliberately forcing the OCR
// path on a PDF that actually has a real text layer and scoring the result
// against the SAME ground truth already used for the normal (text-layer)
// pass.
//
// IMPORTANT SCOPING HONESTY: forcing OCR (scoreAnalysis.js's `forceOcr`,
// see isForceOcrRequested()'s doc comment) affects ONLY the per-page
// measure-number-reading decision. It does not touch section-title matching
// (unconditional on pageItems either way) and, as an existing side effect of
// the code's branch structure, it also fully suppresses tempo-mark reading
// for any page it touches (extractTempoMarks() lives in the same non-OCR
// branch as extractMeasureNumbers(), not a separate unconditional call) --
// so a forced-OCR page loses tempo marks rather than reading them some other
// way. Net effect: this script deliberately scores ONLY system count and
// measures-per-system. It does NOT score section names or BPM sequences --
// doing so would silently misrepresent a 2-dimension probe as a full
// 4-dimension benchmark.
//
// For each ground-truth file this:
//   1. Runs a normal (baseline) analysis pass -- exactly like run.mjs -- to
//      find out whether this file's normal run actually has usedOcr: false
//      (a real text layer). Ground-truth files that already use OCR normally
//      (scanned/image-only PDFs) are skipped; there's nothing to force.
//   2. For text-layer files only, re-navigates to the app with ?forceOcr=1
//      (see appDriver.mjs's withForceOcr()) and re-runs the analysis. Sanity-
//      checks that the app itself reports usedOcr: true this time (if not,
//      the forcing mechanism didn't actually engage for this file -- flagged
//      as a warning, not silently ignored).
//   3. Scores BOTH passes' systemCountAccuracy/measuresPerSystemAccuracy
//      against the same ground truth, so the output directly shows "normal
//      text-layer accuracy" side by side with "OCR-only accuracy on the very
//      same file."
//
// Usage:
//   node scripts/benchmark/run-ocr-validation.mjs [options]
//
// Options: same as run.mjs (--port, --base-url, --cwd, --ground-truth-dir,
// --corpus-root, --out, --headed, --load-timeout, --analyze-timeout) --
// see run.mjs's own header for what each does. --out here defaults under
// benchmarks/ocr-validation/ (NOT benchmarks/snapshots/ -- report.mjs's
// per-commit trend table intentionally never reads this directory, since
// this is a synthetic probe, not "how the app behaves for real users today").

import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDevServer } from './lib/devServer.mjs';
import { loadGroundTruths, loadMeta } from './lib/groundTruth.mjs';
import { analyzeFile, withForceOcr } from './lib/appDriver.mjs';
import { systemCountAccuracy, measuresPerSystemAccuracy } from './lib/scoring.mjs';

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

// Scores one pass (baseline or forced-OCR) against ground truth -- system
// count + measures-per-system only, per this file's module doc above.
function scorePass(gt, app) {
  const systemCountAcc = systemCountAccuracy(app.systemCount, gt.systemCount);
  const countsMatch = app.systemCount === gt.systemCount;
  const measures = countsMatch ? measuresPerSystemAccuracy(gt.measuresPerSystem, app.measuresPerSystem) : null;
  return {
    usedOcr: app.usedOcr,
    systemCount: app.systemCount,
    measuresPerSystem: app.measuresPerSystem,
    systemCountAccuracy: systemCountAcc,
    measuresPerSystemComparable: countsMatch,
    measuresPerSystemAccuracy: measures ? measures.fraction : null,
    measuresPerSystemMeanAbsError: measures ? measures.meanAbsError : null,
  };
}

function mean(nums) {
  const vals = nums.filter((n) => n != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function summarizePass(entries, key) {
  const passes = entries.map((e) => e[key]).filter(Boolean);
  const comparable = passes.filter((p) => p.measuresPerSystemComparable);
  return {
    files: passes.length,
    meanSystemCountAccuracy: mean(passes.map((p) => p.systemCountAccuracy)),
    measuresPerSystemComparableFiles: comparable.length,
    meanMeasuresPerSystemAccuracy: mean(comparable.map((p) => p.measuresPerSystemAccuracy)),
    meanMeasuresPerSystemMeanAbsError: mean(comparable.map((p) => p.measuresPerSystemMeanAbsError)),
  };
}

function pct(x) {
  return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

function defaultOutPath(repoRoot, commitDate, commitHash) {
  const day = new Date(commitDate).toISOString().slice(0, 10);
  const shortSha = commitHash.slice(0, 7);
  return path.join(repoRoot, 'benchmarks', 'ocr-validation', `${day}-${shortSha}.json`);
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
  const forceOcrUrl = withForceOcr(baseUrl);

  const browser = await chromium.launch({ executablePath: chromePath, headless: !args.headed });
  const perFile = [];

  try {
    for (const gt of groundTruths) {
      const pdfPath = path.isAbsolute(gt.file) ? gt.file : path.join(corpusRoot, gt.file);
      if (!existsSync(pdfPath)) {
        console.warn(`SKIP ${gt.file}: not found at ${pdfPath}`);
        perFile.push({ file: gt.file, skipped: true, reason: `PDF not found at ${pdfPath}` });
        continue;
      }

      console.log(`Baseline (normal) pass: ${gt.file}...`);
      let baselineApp;
      const basePage = await browser.newPage();
      try {
        await basePage.goto(baseUrl, { waitUntil: 'load' });
        baselineApp = await analyzeFile(basePage, pdfPath, { loadTimeoutMs, analyzeTimeoutMs });
      } catch (err) {
        console.warn(`ERROR (baseline) analyzing ${gt.file}: ${err.message}`);
        perFile.push({ file: gt.file, skipped: true, reason: `baseline pass error: ${err.message}` });
        continue;
      } finally {
        await basePage.close();
      }

      if (baselineApp.usedOcr) {
        console.log(`  -> already uses OCR normally (no real text layer) -- skipping, nothing to force.`);
        perFile.push({ file: gt.file, skipped: true, reason: 'normal run already uses OCR (no text layer to force away from)' });
        continue;
      }

      console.log(`Forced-OCR pass: ${gt.file}...`);
      let forcedApp;
      const forcedPage = await browser.newPage();
      try {
        await forcedPage.goto(forceOcrUrl, { waitUntil: 'load' });
        forcedApp = await analyzeFile(forcedPage, pdfPath, { loadTimeoutMs, analyzeTimeoutMs });
      } catch (err) {
        console.warn(`ERROR (forced-OCR) analyzing ${gt.file}: ${err.message}`);
        perFile.push({ file: gt.file, skipped: true, reason: `forced-OCR pass error: ${err.message}` });
        continue;
      } finally {
        await forcedPage.close();
      }

      if (!forcedApp.usedOcr) {
        console.warn(`  WARNING: forceOcr did not actually engage the OCR path for ${gt.file} -- mechanism may be broken, or this page had zero detected systems (forceOcr's usedOcr also requires systemsOnThisPage.length > 0).`);
      }

      perFile.push({
        file: gt.file,
        skipped: false,
        forceOcrEngaged: forcedApp.usedOcr,
        truth: { systemCount: gt.systemCount, measuresPerSystem: gt.measuresPerSystem },
        baseline: scorePass(gt, baselineApp),
        forcedOcr: scorePass(gt, forcedApp),
      });
    }
  } finally {
    await browser.close();
    if (devServer) await devServer.stop();
  }

  const scored = perFile.filter((f) => !f.skipped);
  const summary = {
    totalGroundTruthFiles: perFile.length,
    scoredFiles: scored.length,
    skippedFiles: perFile.length - scored.length,
    baseline: summarizePass(scored, 'baseline'),
    forcedOcr: summarizePass(scored, 'forcedOcr'),
  };

  const snapshot = {
    kind: 'ocr-validation', // marks this as the synthetic probe, not a run.mjs trend snapshot
    commitHash, commitDate, runDate: new Date().toISOString(),
    perFile, summary,
  };

  const outPath = args.out ? path.resolve(args.out) : defaultOutPath(REPO_ROOT, commitDate, commitHash);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\nWrote OCR validation result: ${outPath}`);

  console.log(`\nScored ${summary.scoredFiles}/${summary.totalGroundTruthFiles} ground-truth files (${summary.skippedFiles} skipped -- already OCR normally, or errored).`);
  console.log(`\n-- Normal (text-layer) pass, same files --`);
  console.log(`System count accuracy:      ${pct(summary.baseline.meanSystemCountAccuracy)}`);
  console.log(`Measures/system accuracy:   ${pct(summary.baseline.meanMeasuresPerSystemAccuracy)} (MAE ${summary.baseline.meanMeasuresPerSystemMeanAbsError ?? 'n/a'}, ${summary.baseline.measuresPerSystemComparableFiles}/${summary.baseline.files} files comparable)`);
  console.log(`\n-- Forced-OCR pass, SAME files --`);
  console.log(`System count accuracy:      ${pct(summary.forcedOcr.meanSystemCountAccuracy)}`);
  console.log(`Measures/system accuracy:   ${pct(summary.forcedOcr.meanMeasuresPerSystemAccuracy)} (MAE ${summary.forcedOcr.meanMeasuresPerSystemMeanAbsError ?? 'n/a'}, ${summary.forcedOcr.measuresPerSystemComparableFiles}/${summary.forcedOcr.files} files comparable)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
