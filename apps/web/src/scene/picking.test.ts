import { describe, expect, it } from 'vitest';
import { MAX_STROKE_STEP, tilesBetween } from './picking.js';

const t = (wx: number, wy: number, plane = 0) => ({ plane, wx, wy });

describe('tilesBetween', () => {
  it('is empty for the same tile and just the target for a neighbour', () => {
    expect(tilesBetween(t(5, 5), t(5, 5))).toEqual([]);
    expect(tilesBetween(t(5, 5), t(6, 5))).toEqual([t(6, 5)]);
  });

  it('fills a straight run without gaps', () => {
    expect(tilesBetween(t(0, 0), t(4, 0))).toEqual([t(1, 0), t(2, 0), t(3, 0), t(4, 0)]);
    expect(tilesBetween(t(0, 4), t(0, 1))).toEqual([t(0, 3), t(0, 2), t(0, 1)]);
  });

  it('walks a diagonal one axis at a time, ending on the target', () => {
    const path = tilesBetween(t(0, 0), t(3, -3));
    expect(path).toHaveLength(6);
    expect(path.at(-1)).toEqual(t(3, -3));
    let prev = t(0, 0);
    for (const p of path) {
      expect(Math.abs(p.wx - prev.wx) + Math.abs(p.wy - prev.wy)).toBe(1);
      prev = p;
    }
  });

  it('stays close to the line for a shallow slope', () => {
    const path = tilesBetween(t(0, 0), t(8, 2));
    for (const p of path) expect(Math.abs(p.wy - (p.wx * 2) / 8)).toBeLessThanOrEqual(1);
  });

  it('does not bridge a plane change or a jump', () => {
    expect(tilesBetween(t(0, 0, 0), t(2, 0, 1))).toEqual([t(2, 0, 1)]);
    expect(tilesBetween(t(0, 0), t(MAX_STROKE_STEP + 1, 0))).toEqual([t(MAX_STROKE_STEP + 1, 0)]);
  });
});
