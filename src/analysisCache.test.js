import { describe, it, expect } from 'vitest';
import { cacheKey, hashBytes } from './analysisCache.js';

const bytes = (s) => new TextEncoder().encode(s).buffer;

describe('cacheKey', () => {
  it('separates different documents', () => {
    expect(cacheKey('aaa')).not.toBe(cacheKey('bbb'));
  });

  /* The bug this exists to prevent: ?forceOcr=1 makes every page take the OCR
   * path regardless of its text layer, so it produces a legitimately
   * different detection for the same bytes. Keyed on the hash alone, one
   * forced run would serve its result to every normal run afterwards. */
  it('separates detection variants of the same document', () => {
    expect(cacheKey('aaa', 'forceOcr')).not.toBe(cacheKey('aaa', ''));
    expect(cacheKey('aaa', 'forceOcr')).not.toBe(cacheKey('aaa'));
  });

  it('treats an omitted variant and an empty one as the same thing', () => {
    expect(cacheKey('aaa')).toBe(cacheKey('aaa', ''));
  });

  // Keys are matched by build-id prefix when pruning entries from earlier
  // builds (pruneOtherBuilds), so the build id has to come first and be
  // delimited -- not merely present somewhere in the string.
  it('puts the build id first, delimited', () => {
    const key = cacheKey('aaa', 'v');
    expect(key.split(':')).toHaveLength(3);
    expect(key.endsWith(':aaa')).toBe(true);
  });

  // A hash could otherwise run into the variant and let two different
  // (variant, hash) pairs produce one key.
  it('cannot collide across the variant boundary', () => {
    expect(cacheKey('bbb', 'aaa')).not.toBe(cacheKey('aaabbb', ''));
  });
});

describe('hashBytes', () => {
  it('is stable for identical content', async () => {
    expect(await hashBytes(bytes('same'))).toBe(await hashBytes(bytes('same')));
  });

  it('differs for different content', async () => {
    expect(await hashBytes(bytes('one'))).not.toBe(await hashBytes(bytes('two')));
  });

  it('produces a 64-char hex SHA-256', async () => {
    expect(await hashBytes(bytes('x'))).toMatch(/^[0-9a-f]{64}$/);
  });

  // Every byte pair must be zero-padded; without padStart, a digest byte
  // below 0x10 would emit one hex char and shift the rest of the string,
  // making distinct digests capable of colliding.
  it('zero-pads every byte', async () => {
    // SHA-256("abc") is a known vector whose second byte is 0x78 and which
    // contains low bytes later on -- the length check is the real assertion.
    const h = await hashBytes(bytes('abc'));
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
