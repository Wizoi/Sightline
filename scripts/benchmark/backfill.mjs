#!/usr/bin/env node
// Runs the CURRENT (HEAD) benchmark scoring logic against several
// HISTORICAL commits of the app, so the trend report (report.mjs) has more
// than one data point the first time it's used. For each candidate commit:
// checks out a real `git worktree`, npm-installs it, starts ITS OWN dev
// server, and runs THIS checkout's run.mjs against it (so today's scoring
// logic is applied retroactively, not that commit's -- run.mjs/scoring.mjs
// may not have even existed yet at some of these commits) -- then tags the
// resulting snapshot with the historical commit's real hash/date before
// tearing the worktree down.
//
// Candidate commits below were picked from `git log --oneline` to span
// this feature's real evolution (see docs/PERSONAS.md section 3): the
// initial "score sections" feature, the multi-staff-grouping fix, the OCR
// fallback for image-only PDFs, its two-reading follow-up, the rotation +
// general accuracy fixes, and current HEAD's backlog closeout. Update this
// list by hand as the feature evolves further -- there's no automatic
// "pick interesting commits" heuristic here on purpose, since judging which
// commits are actually meaningful accuracy milestones is exactly the kind
// of thing that needs a human (or an agent reading the log) to pick.
const CANDIDATE_COMMITS = process.env.BENCHMARK_BACKFILL_TEST_COMMITS
  // TEMP, for manual smoke-testing only -- e.g.
  //   BENCHMARK_BACKFILL_TEST_COMMITS=c18988e node scripts/benchmark/backfill.mjs
  ? process.env.BENCHMARK_BACKFILL_TEST_COMMITS.split(',')
  : [
    '49c66a4', // Add score sections: detect parts, tempo markings, and measure numbers from PDF text
    '89bab60', // Fix multi-staff system grouping and make tempo/time-sig sliders live
    'b58b58d', // Read measure numbers from image-only PDFs via OCR fallback
    '41fa477', // Read image-PDF measure numbers two ways, let the user pick
    '1e742bd', // Fix Analyze-score accuracy on scanned and multi-part real-world scores
    'c18988e', // Close out remaining Analyze-score backlog: staff density, over-split, names
  ];

import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDevServer } from './lib/devServer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const RUN_SCRIPT = path.join(HERE, 'run.mjs');

function gitInfo(hash) {
  const raw = execSync(`git log -1 --format=%H,%cI ${hash}`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const [fullHash, date] = raw.split(',');
  return { fullHash, date };
}

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
  }
}

const isWin = process.platform === 'win32';

// Windows can't spawn npm's .cmd shim without shell:true (same EINVAL seen
// in devServer.mjs's startDevServer -- see its own comment for detail).
// git.exe and node.exe are real executables and don't need this.
function runNpm(args, opts) {
  if (isWin) run(`npm ${args.join(' ')}`, [], { ...opts, shell: true });
  else run('npm', args, opts);
}

async function backfillOne(hash) {
  const { fullHash, date } = gitInfo(hash);
  console.log(`\n=== Backfilling ${hash} (${fullHash.slice(0, 7)}, ${date}) ===`);

  const worktreeDir = mkdtempSync(path.join(os.tmpdir(), `sightline-benchmark-${hash}-`));
  // mkdtempSync already creates the directory; `git worktree add` refuses to
  // reuse an existing non-empty one, but insists even on an existing EMPTY
  // directory unless it's removed first -- so drop it and let worktree
  // create it fresh.
  rmSync(worktreeDir, { recursive: true, force: true });

  let devServer = null;
  try {
    console.log(`Creating worktree at ${worktreeDir}...`);
    run('git', ['worktree', 'add', '--detach', worktreeDir, fullHash], { cwd: REPO_ROOT });

    console.log('Installing dependencies in the worktree...');
    const installArgs = existsSync(path.join(worktreeDir, 'package-lock.json')) ? ['ci'] : ['install'];
    runNpm(installArgs, { cwd: worktreeDir });

    console.log('Starting dev server for the worktree...');
    devServer = await startDevServer(worktreeDir, { readyTimeoutMs: 120000, label: `worktree ${hash} dev server` });
    console.log(`Worktree dev server ready at ${devServer.baseUrl}`);

    console.log('Running benchmark (current HEAD scoring logic) against it...');
    const nodeArgs = [
      RUN_SCRIPT,
      '--port', String(devServer.port),
      '--commit-hash', fullHash,
      '--commit-date', date,
    ];
    run(process.execPath, nodeArgs, { cwd: REPO_ROOT });
  } finally {
    if (devServer) {
      console.log('Stopping worktree dev server...');
      await devServer.stop();
    }
    console.log('Removing worktree...');
    try {
      run('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: REPO_ROOT });
    } catch (err) {
      console.warn(`git worktree remove failed (${err.message}); cleaning up the directory directly.`);
      rmSync(worktreeDir, { recursive: true, force: true });
      try { execSync('git worktree prune', { cwd: REPO_ROOT }); } catch { /* best effort */ }
    }
  }
}

async function main() {
  for (const hash of CANDIDATE_COMMITS) {
    await backfillOne(hash);
  }
  console.log('\nBackfill complete. Run `node scripts/benchmark/report.mjs` to see the trend.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
