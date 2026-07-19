import { describe, it, expect } from 'vitest';
import { describeWinkStatus } from './winkStatus.js';

describe('describeWinkStatus', () => {
  it('reports idle/no-wink as a neutral resting state, not an error', () => {
    const r = describeWinkStatus({ cls: 's-bad', text: 'no gaze — hold' }, '–');
    expect(r).toEqual({ cls: '', text: 'watching for a wink' });
  });

  it('treats "off" and "read" the same as idle (no wink currently held)', () => {
    expect(describeWinkStatus({ cls: 's-warn', text: 'looking away — hold' }, 'off'))
      .toEqual({ cls: '', text: 'watching for a wink' });
    expect(describeWinkStatus({ cls: 's-good', text: 'reading' }, 'read'))
      .toEqual({ cls: '', text: 'watching for a wink' });
  });

  it('reports a pending (not-yet-engaged) up/down wink as "detected — hold…"', () => {
    const r = describeWinkStatus({ cls: 's-good', text: 'hold…' }, 'up');
    expect(r.text).toBe('wink detected — hold…');
  });

  it('reports an engaged upward wink scroll clearly', () => {
    const r = describeWinkStatus({ cls: 's-good', text: 'following' }, 'up');
    expect(r.text).toContain('up');
    expect(r.text.toLowerCase()).toContain('wink');
  });

  it('reports an engaged downward wink scroll clearly', () => {
    const r = describeWinkStatus({ cls: 's-good', text: 'following' }, 'down');
    expect(r.text).toContain('down');
  });

  it('reports a pending snap-mode wink (advance/back) as "detected — hold…"', () => {
    const r = describeWinkStatus({ cls: 's-good', text: 'advance → snap' }, 'down');
    expect(r.text).toBe('wink detected — hold…');
  });

  it('reports an active snap as jumping', () => {
    const r = describeWinkStatus({ cls: 's-good', text: 'snapping…' }, 'snap');
    expect(r.text.toLowerCase()).toContain('jump');
  });

  it('preserves the original status class for active states', () => {
    const r = describeWinkStatus({ cls: 's-good', text: 'following' }, 'up');
    expect(r.cls).toBe('s-good');
  });
});
