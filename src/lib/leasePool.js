/* A small pool of expensive, reusable resources handed out one job at a time.
 *
 * Written for the OCR workers (src/ocr.js), where the resource is a Tesseract
 * worker: slow to create, memory-hungry, and safe to reuse but NOT safe to
 * share concurrently, since a job configures the worker before recognizing.
 * Kept generic and free of any DOM/Tesseract reference so the awkward part --
 * the lease bookkeeping, which is invisible when it goes wrong -- can be
 * tested directly.
 *
 * Three behaviours matter and are what the tests pin down:
 *   - never more than `max` resources exist, however many jobs pile up;
 *   - resources are created only under real contention, so a workload that
 *     never runs two jobs at once only ever pays to create one;
 *   - a finished job hands its resource straight to a waiting job rather than
 *     parking it, so nobody waits behind an idle resource.
 */
export function createLeasePool({ max, spawn, configure }) {
  const all = [];        // every entry created so far: { resource, profile }
  const idle = [];       // entries not currently leased
  const waiters = [];    // resolve() callbacks for jobs queued behind a full pool
  let creating = 0;      // in-flight spawns, counted so concurrent acquires
                         // don't each decide there's room and overshoot `max`

  async function acquire() {
    const free = idle.pop();
    if (free) return free;
    if (all.length + creating < max) {
      creating++;
      try {
        const entry = { resource: await spawn(), profile: null };
        all.push(entry);
        return entry;
      } finally {
        creating--;
      }
    }
    return new Promise((resolve) => { waiters.push(resolve); });
  }

  function release(entry) {
    const next = waiters.shift();
    if (next) next(entry); else idle.push(entry);
  }

  return {
    /* Leases a resource, brings it to `profile` if it isn't already there,
     * and runs `fn` against it. The resource is released even if `fn` throws
     * -- a failed job must not permanently shrink the pool. */
    async run(profile, fn) {
      const entry = await acquire();
      try {
        if (configure && entry.profile !== profile) {
          await configure(entry.resource, profile);
          entry.profile = profile;
        }
        return await fn(entry.resource);
      } finally {
        release(entry);
      }
    },

    /* Disposes every resource and resets to empty. Queued waiters are
     * dropped rather than resolved: reaching here with jobs still queued
     * means whoever owned them has already finished, and handing them a
     * disposed resource would be worse than leaving them pending. */
    async drain(dispose) {
      const entries = all.splice(0, all.length);
      idle.length = 0;
      waiters.length = 0;
      if (dispose) await Promise.all(entries.map((e) => dispose(e.resource)));
    },

    // Inspection for tests and diagnostics; not part of normal operation.
    stats: () => ({ size: all.length, idle: idle.length, waiting: waiters.length }),
  };
}
