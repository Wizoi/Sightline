import { describe, it, expect } from 'vitest';
import { detectStaffRows } from './inkScan.js';

// Build an isInk(row, col) callback from a set of "fully inked" rows plus an
// explicit width, matching the (isInk, aw, ah) calling convention this
// function shares with the rest of this codebase's pixel scanners.
function inkFromRows(inkedRows, aw, ah, { runLength = aw } = {}) {
  const rowSet = new Set(inkedRows);
  return (r, c) => rowSet.has(r) && c < runLength;
}

describe('detectStaffRows', () => {
  it('returns no rows when nothing is inked', () => {
    const isInk = () => false;
    expect(detectStaffRows(isInk, 100, 20)).toEqual([]);
  });

  it('picks rows whose longest ink run exceeds the width threshold', () => {
    const isInk = inkFromRows([3, 9], 100, 20);
    expect(detectStaffRows(isInk, 100, 20)).toEqual([3, 9]);
  });

  it('ignores a row whose ink run falls short of the default 0.45*width need', () => {
    // Run length 44 out of width 100 -- just short of the default need (45).
    const isInk = inkFromRows([5], 100, 20, { runLength: 44 });
    expect(detectStaffRows(isInk, 100, 20)).toEqual([]);
  });

  it('includes a row whose ink run just clears the default 0.45*width need', () => {
    // Run length 46 out of width 100 -- just over the default need (45).
    const isInk = inkFromRows([5], 100, 20, { runLength: 46 });
    expect(detectStaffRows(isInk, 100, 20)).toEqual([5]);
  });

  it('only counts the longest contiguous run, not total inked pixels on the row', () => {
    // Two short separate ink runs (20 + 20 = 40 total) neither individually
    // nor combined-as-a-single-run reach the 45px need for a 100px-wide row
    // -- scattered ink (e.g. note heads/stems, not a staff line) must not
    // register as a detected row.
    const isInk = (r, c) => r === 7 && ((c >= 0 && c < 20) || (c >= 60 && c < 80));
    expect(detectStaffRows(isInk, 100, 20)).toEqual([]);
  });

  it('honors a custom widthFrac threshold', () => {
    const isInk = inkFromRows([2], 100, 10, { runLength: 30 });
    expect(detectStaffRows(isInk, 100, 10)).toEqual([]); // default 0.45 -> need 45, misses
    expect(detectStaffRows(isInk, 100, 10, { widthFrac: 0.25 })).toEqual([2]); // need 25, hits
  });
});
