// Starts/stops a Vite dev server for the benchmark runner. Deliberately
// shells out to the project's own `npm run dev` (not vite's programmatic
// API) so this exercises exactly the same predev asset-fetch + Vite config
// path a real developer running the app would, in whichever checkout
// (current working tree, or a historical worktree during backfill.mjs) is
// passed as `cwd`.

import { spawn } from 'node:child_process';
import net from 'node:net';

// Finds a free TCP port by letting the OS assign one (listen on port 0),
// then closing immediately -- a small window-of-opportunity race with
// something else grabbing the same port before Vite binds it exists in
// theory, but is not worth guarding against for a local dev-only tool.
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok || res.status < 500) return; // any real HTTP response means the server is up
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Dev server at ${url} did not become reachable within ${timeoutMs}ms (${lastErr?.message || 'no response'})`);
}

// Starts `npm run dev -- --port <port> --strictPort` in `cwd` and waits
// until it actually answers HTTP requests. Returns { port, baseUrl, stop() }.
// --strictPort makes Vite fail loudly instead of silently picking a
// different port if the requested one is somehow already taken, which would
// otherwise leave this function waiting on the wrong URL forever.
export async function startDevServer(cwd, { port, readyTimeoutMs = 60000, label = 'dev server' } = {}) {
  const resolvedPort = port ?? (await findFreePort());
  const isWin = process.platform === 'win32';
  // Windows can't spawn a .cmd shim (npm's own launcher) without shell:true
  // -- confirmed directly (spawn() throws EINVAL otherwise on this
  // platform); shell:true is what lets Windows resolve `npm` via PATHEXT the
  // same way a real terminal would. Passing the whole command as ONE string
  // (rather than shell:true + a separate args array) avoids Node's
  // DEP0190 warning about unescaped array-arg concatenation under
  // shell:true -- there's no untrusted input here (cwd/port are this
  // script's own values), but the single-string form is simple and doesn't
  // nag either way.
  const child = isWin
    ? spawn(`npm run dev -- --port ${resolvedPort} --strictPort`, [], { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('npm', ['run', 'dev', '--', '--port', String(resolvedPort), '--strictPort'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  let exited = false;
  let exitInfo = null;
  child.on('exit', (code, signal) => { exited = true; exitInfo = { code, signal }; });

  const baseUrl = `http://localhost:${resolvedPort}`;

  // Race the HTTP poll against the process exiting early (e.g. predev's
  // asset-fetch script failing, or the port genuinely being taken despite
  // findFreePort()'s best effort) so a broken worktree fails fast with a
  // useful message instead of the full readyTimeoutMs.
  await Promise.race([
    waitForServer(baseUrl, readyTimeoutMs),
    new Promise((_, reject) => {
      const check = setInterval(() => {
        if (exited) {
          clearInterval(check);
          reject(new Error(`${label} exited early (code=${exitInfo.code}, signal=${exitInfo.signal}) before becoming reachable.\nOutput:\n${output.slice(-4000)}`));
        }
      }, 200);
    }),
  ]).catch((err) => {
    try { child.kill(); } catch { /* already dead */ }
    throw err;
  });

  return {
    port: resolvedPort,
    baseUrl,
    stop() {
      return new Promise((resolve) => {
        if (exited) { resolve(); return; }
        child.once('exit', () => resolve());
        // Windows needs the process tree killed via taskkill -- plain
        // child.kill() only signals the `npm` wrapper, leaving the real
        // `vite`/`esbuild` child processes (and the port) alive behind it.
        if (isWin) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
        // Don't hang forever if the process is already gone by the time we
        // get here.
        setTimeout(resolve, 5000);
      });
    },
  };
}
