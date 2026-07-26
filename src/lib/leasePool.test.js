import { describe, it, expect } from 'vitest';
import { createLeasePool } from './leasePool.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

// A resource whose job can be released on demand, so a test can hold jobs
// open and observe the pool while they're all in flight.
function harness({ max = 2 } = {}) {
  let spawned = 0;
  const configured = [];
  const pool = createLeasePool({
    max,
    spawn: async () => ({ id: ++spawned }),
    configure: async (res, profile) => { configured.push([res.id, profile]); },
  });
  const open = [];
  const run = (profile = 'p') => pool.run(profile, (res) => new Promise((resolve) => {
    open.push({ id: res.id, finish: () => resolve(res.id) });
  }));
  return { pool, run, open, configured, spawnCount: () => spawned };
}

describe('createLeasePool', () => {
  it('never creates more than max, however many jobs pile up', async () => {
    const h = harness({ max: 2 });
    const jobs = [h.run(), h.run(), h.run(), h.run(), h.run()];
    await tick();
    // Two leased, the other three queued -- no third resource was created.
    expect(h.spawnCount()).toBe(2);
    expect(h.pool.stats()).toEqual({ size: 2, idle: 0, waiting: 3 });
    // Drain in rounds: finishing a job admits a waiter, which then appears in
    // `open` itself, so this takes several passes to work through all five.
    let done = 0;
    while (done < h.open.length) {
      h.open[done++].finish();
      await tick();
    }
    await Promise.all(jobs);
    expect(h.spawnCount()).toBe(2);
    expect(h.pool.stats()).toEqual({ size: 2, idle: 2, waiting: 0 });
  });

  // The pool exists to be lazy: an analysis that only ever needs one
  // recognition at a time should not pay to spin up (and hold the memory of)
  // four Tesseract workers.
  it('creates only one resource when jobs never overlap', async () => {
    const h = harness({ max: 4 });
    for (let i = 0; i < 5; i++) {
      const p = h.run();
      await tick();
      h.open[h.open.length - 1].finish();
      await p;
    }
    expect(h.spawnCount()).toBe(1);
  });

  // Concurrent acquires must not each independently conclude there's room --
  // that's what `creating` guards, and without it a burst of jobs arriving
  // together would overshoot max by however many spawns were in flight.
  it('does not overshoot max when many jobs start in the same tick', async () => {
    let spawned = 0;
    const pool = createLeasePool({
      max: 3,
      // A slow spawn widens the window in which the count is wrong.
      spawn: async () => { await tick(); return { id: ++spawned }; },
    });
    await Promise.all(Array.from({ length: 12 }, () => pool.run('p', async () => tick())));
    expect(spawned).toBe(3);
  });

  it('hands a released resource straight to a waiting job', async () => {
    const h = harness({ max: 1 });
    const first = h.run();
    await tick();
    const second = h.run();
    await tick();
    expect(h.pool.stats()).toEqual({ size: 1, idle: 0, waiting: 1 });
    h.open[0].finish();
    await first;
    await tick();
    // The waiter got it directly -- it never passed through the idle list.
    expect(h.pool.stats()).toEqual({ size: 1, idle: 0, waiting: 0 });
    h.open[1].finish();
    await expect(second).resolves.toBe(1);
  });

  it('reconfigures only when the profile actually changes', async () => {
    const h = harness({ max: 1 });
    for (const profile of ['a', 'a', 'b', 'b', 'a']) {
      const p = h.run(profile);
      await tick();
      h.open[h.open.length - 1].finish();
      await p;
    }
    expect(h.configured).toEqual([[1, 'a'], [1, 'b'], [1, 'a']]);
  });

  // A job that throws must still give its resource back; otherwise a single
  // failed recognition permanently shrinks the pool and enough of them
  // deadlock it.
  it('releases the resource when a job throws', async () => {
    const pool = createLeasePool({ max: 1, spawn: async () => ({}) });
    await expect(pool.run('p', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(pool.stats()).toEqual({ size: 1, idle: 1, waiting: 0 });
    await expect(pool.run('p', async () => 'ok')).resolves.toBe('ok');
  });

  it('disposes everything on drain and starts fresh afterwards', async () => {
    const disposed = [];
    let spawned = 0;
    const pool = createLeasePool({ max: 2, spawn: async () => ({ id: ++spawned }) });
    await Promise.all([pool.run('p', async () => tick()), pool.run('p', async () => tick())]);
    expect(pool.stats().size).toBe(2);
    await pool.drain((r) => { disposed.push(r.id); });
    expect(disposed.sort()).toEqual([1, 2]);
    expect(pool.stats()).toEqual({ size: 0, idle: 0, waiting: 0 });
    await pool.run('p', async () => {});
    expect(spawned).toBe(3);   // drained, so this had to spawn anew
  });
});
