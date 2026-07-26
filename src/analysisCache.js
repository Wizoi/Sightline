/* Caches the expensive half of "Analyze score" against the PDF's content hash.
 *
 * Analyzing a scanned 40-page score takes ~44s, almost all of it OCR (see
 * ocr.js's pool comment). That cost is paid again every single time the piece
 * is opened, for a result that cannot have changed -- the PDF is the same
 * bytes. Practising the same piece across sessions is the normal case, so
 * this is the difference between a 44s wait per session and one wait ever.
 *
 * WHAT IS CACHED is deliberately only the detection half: system bands,
 * per-system measure estimates, the OCR'd/text-layer measure numbers, tempo
 * marks, detected time signatures, resolved page rotations, section
 * boundaries. All of it is a pure function of the PDF's pixels and text.
 * Everything downstream -- building sections, resolving the tempo schedule,
 * choosing between the two measure-number readings -- depends on live user
 * settings (beats per measure, the tempo slider) and is recomputed on every
 * analyze, cached or not. It is microseconds of array work, and keeping it
 * outside the cache is what stops a cached run from quietly pinning settings
 * to whatever they were when the piece was first analyzed.
 *
 * INVALIDATION is by build id, not a hand-maintained version constant. A
 * constant someone has to remember to bump is exactly the kind of thing that
 * gets missed while tuning a detection threshold, and the failure is silent
 * and awful: the app keeps serving results from the OLD detector and the
 * change looks like it did nothing. Keying on a value that changes every
 * build (see vite.config.js) makes that impossible to get wrong. The cost is
 * that shipping any update drops everyone's cache and the next analyze of
 * each piece is slow again -- the right side of that trade, since a wrong
 * cached analysis is far worse than a slow correct one.
 */

const DB_NAME = 'sightline-analysis';
const DB_VERSION = 1;
const STORE = 'detections';

// Injected by vite.config.js; changes on every build and every dev-server
// start. The fallback only matters in a non-Vite context (unit tests).
const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

// Set by the benchmark harness so a measurement run always exercises the real
// detector. Without this, the second benchmark run of a corpus would score
// the FIRST run's cached output and any regression introduced in between
// would be invisible -- the one place where a silently-correct cache would do
// real damage.
export function cacheDisabled() {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('noCache') === '1';
}

// SHA-256 of the PDF's bytes. Must be taken BEFORE the buffer is handed to
// pdf.js, which may detach it (see pdf.js's loadPdf).
export async function hashBytes(buffer) {
  if (!globalThis.crypto?.subtle) return null; // non-secure context: no hashing, so no caching
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Content hash + build id + detection variant.
 *
 * `variant` exists because the PDF's bytes are not quite the whole input to
 * detection: ?forceOcr=1 makes every page take the OCR path regardless of its
 * text layer, producing a legitimately different (and equally cacheable)
 * result for the same file. Without it in the key, analyzing once with that
 * flag would serve the forced result to every subsequent normal run, and
 * vice versa.
 *
 * ANY future flag that changes what detectScore() produces belongs here too.
 * The caller owns this string precisely because scoreAnalysis.js is what
 * knows which of its inputs matter -- this module cannot guess. */
export const cacheKey = (pdfHash, variant = '') => `${BUILD_ID}:${variant}:${pdfHash}`;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const request = fn(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* Every entry point swallows its own failures and reports a miss. A cache is
 * an optimization: private browsing, a storage quota, a disabled IndexedDB or
 * a corrupt entry must all degrade to "analyze normally", never to an error
 * the user sees on a feature that otherwise works. */
export async function readDetection(pdfHash, variant) {
  if (!pdfHash || cacheDisabled() || typeof indexedDB === 'undefined') return null;
  try {
    const db = await openDb();
    const hit = await tx(db, 'readonly', (store) => store.get(cacheKey(pdfHash, variant)));
    db.close();
    return hit || null;
  } catch {
    return null;
  }
}

/* Entries from earlier builds can never be read again -- the build id is part
 * of every key -- so without this they accumulate forever, one dead copy of
 * every score the user has ever analyzed per app update. Pruning rides along
 * with the write that just proved storage is working, rather than running on
 * open: it costs one key listing on the rare path (an actual cache miss) and
 * nothing at all on the common one. */
function pruneOtherBuilds(store) {
  const prefix = `${BUILD_ID}:`;
  const req = store.getAllKeys();
  req.onsuccess = () => {
    for (const key of req.result) {
      if (typeof key === 'string' && !key.startsWith(prefix)) store.delete(key);
    }
  };
}

export async function writeDetection(pdfHash, detection, variant) {
  if (!pdfHash || cacheDisabled() || typeof indexedDB === 'undefined') return false;
  try {
    const db = await openDb();
    await tx(db, 'readwrite', (store) => {
      pruneOtherBuilds(store);
      return store.put(detection, cacheKey(pdfHash, variant));
    });
    db.close();
    return true;
  } catch {
    return false; // quota exceeded on a big score, most likely -- not worth surfacing
  }
}
