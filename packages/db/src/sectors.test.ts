import { describe, expect, it } from 'vitest';
import {
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  SECTOR_FRAME_BYTES
} from '@rsc-editor/schema';
import { createDb } from './client.js';
import {
  neighbourCoords,
  putSector,
  sectorRadiusBox,
  sectorsInBoxQuery
} from './sectors.js';

const { db } = createDb('postgres://rsc:rsc@localhost:5432/rsc_editor_test');

describe('sectorRadiusBox', () => {
  it('is a square window around the centre', () => {
    expect(sectorRadiusBox({ plane: 0, x: 50, y: 40 }, 2)).toEqual({
      plane: 0,
      minX: 48,
      maxX: 52,
      minY: 38,
      maxY: 42
    });
  });

  it('radius 0 is the single centre sector', () => {
    const box = sectorRadiusBox({ plane: 3, x: 10, y: 10 }, 0);
    expect(box).toEqual({ plane: 3, minX: 10, maxX: 10, minY: 10, maxY: 10 });
  });

  it('clamps at the world edges rather than emitting negative bounds', () => {
    const low = sectorRadiusBox({ plane: 0, x: 1, y: 0 }, 3);
    expect(low.minX).toBe(0);
    expect(low.minY).toBe(0);

    const high = sectorRadiusBox(
      { plane: 0, x: MAX_X_SECTORS - 1, y: MAX_Y_SECTORS - 1 },
      5
    );
    expect(high.maxX).toBe(MAX_X_SECTORS - 1);
    expect(high.maxY).toBe(MAX_Y_SECTORS - 1);
  });

  it('rejects a nonsense radius instead of returning an inverted box', () => {
    expect(() => sectorRadiusBox({ plane: 0, x: 5, y: 5 }, -1)).toThrow();
    expect(() => sectorRadiusBox({ plane: 0, x: 5, y: 5 }, 1.5)).toThrow();
  });
});

describe('neighbourCoords', () => {
  it('gives the 8 surrounding sectors on the same plane', () => {
    const n = neighbourCoords({ plane: 1, x: 20, y: 20 });
    expect(n).toHaveLength(8);
    expect(n.every((c) => c.plane === 1)).toBe(true);
    expect(n).not.toContainEqual({ plane: 1, x: 20, y: 20 });
  });

  it('drops neighbours outside the world', () => {
    expect(neighbourCoords({ plane: 0, x: 0, y: 0 })).toHaveLength(3);
    expect(
      neighbourCoords({ plane: 0, x: MAX_X_SECTORS - 1, y: MAX_Y_SECTORS - 1 })
    ).toHaveLength(3);
  });
});

describe('radius fetch SQL', () => {
  it('is an equality prefix on (project, plane) then ranges on x and y', () => {
    const { sql, params } = sectorsInBoxQuery(db, 'p1', {
      plane: 0,
      minX: 48,
      maxX: 52,
      minY: 38,
      maxY: 42
    }).toSQL();

    const normalised = sql.replace(/\s+/g, ' ');

    // This column order is what lets `sectors_project_coord_key` serve the
    // query with a single index scan; a rewrite that dropped the plane equality
    // would quietly turn every camera move into a seq scan.
    expect(normalised).toMatch(/"sectors"\."project_id" = \$\d/);
    expect(normalised).toMatch(/"sectors"\."plane" = \$\d/);
    expect(normalised).toMatch(/"sectors"\."x" between \$\d and \$\d/i);
    expect(normalised).toMatch(/"sectors"\."y" between \$\d and \$\d/i);
    expect(normalised).toMatch(/order by .*"x".*"y"/i);

    expect(params).toEqual(['p1', 0, 48, 52, 38, 42]);
  });
});

describe('payload validation', () => {
  it('rejects a frame of the wrong length before touching the database', async () => {
    await expect(
      putSector(db, {
        projectId: 'p',
        coord: { plane: 0, x: 50, y: 49 },
        payload: new Uint8Array(10)
      })
    ).rejects.toThrow(
      new RegExp(`expected ${SECTOR_FRAME_BYTES} bytes, got 10`)
    );
  });
});
