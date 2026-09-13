/**
 * The store's job in one sentence: no edit reaches a lane except through an op,
 * and no op reaches a lane you do not hold. These tests pin both.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SECTOR_WIDTH, emptySectorBuffers, sectorKey } from '@rsc-editor/schema';
import type { Lock, SectorCoord } from '@rsc-editor/schema';
import { useEditor } from './editorStore.js';
import { buildElevationOp } from '../ops/builders.js';

const ME = '00000000-0000-4000-8000-000000000001';
const THEM = '00000000-0000-4000-8000-000000000002';
const A: SectorCoord = { plane: 0, x: 50, y: 50 };
const B: SectorCoord = { plane: 0, x: 51, y: 50 };

function lock(coord: SectorCoord, userId: string, displayName: string): Lock {
  return {
    sector: coord,
    userId,
    displayName,
    expiresAt: new Date(Date.now() + 120_000).toISOString()
  };
}

function seed(locks: Record<string, Lock>): void {
  const mk = (coord: SectorCoord) => {
    const buffers = emptySectorBuffers();
    buffers.elevation.fill(100);
    return { coord, buffers, members: false, rev: 0 };
  };
  useEditor.setState({
    me: {
      userId: ME,
      displayName: 'you',
      avatarUrl: null,
      colour: '#4c9aff',
      camera: null,
      activeTool: null,
      selectedSector: null
    },
    peers: {},
    locks,
    sectors: { [sectorKey(A)]: mk(A), [sectorKey(B)]: mk(B) },
    undoStack: [],
    redoStack: [],
    history: [],
    notice: null
  });
}

const readSector = (c: SectorCoord) => useEditor.getState().sectors[sectorKey(c)]?.buffers;

describe('commit', () => {
  beforeEach(() => seed({ [sectorKey(A)]: lock(A, ME, 'you') }));

  it('applies the op, records a transaction, and bumps the sector revision', () => {
    const result = buildElevationOp(
      { plane: 0, wx: 50 * 48 + 24, wy: 50 * 48 + 24 },
      { mode: 'raise', radius: 2, falloff: 'constant', shape: 'square', strength: 1 },
      readSector
    );
    useEditor.getState().commit(result);

    const state = useEditor.getState();
    const loaded = state.sectors[sectorKey(A)]!;
    expect(loaded.buffers.elevation[24 * SECTOR_WIDTH + 24]).toBe(124);
    expect(loaded.rev).toBe(1);
    expect(state.undoStack).toHaveLength(1);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]!.tx.label).toBe('Raise terrain');
  });

  it('undo restores the exact previous values, redo reapplies them', () => {
    const result = buildElevationOp(
      { plane: 0, wx: 50 * 48 + 24, wy: 50 * 48 + 24 },
      { mode: 'raise', radius: 2, falloff: 'linear', shape: 'circle', strength: 0.7 },
      readSector
    );
    const before = Uint8Array.from(useEditor.getState().sectors[sectorKey(A)]!.buffers.elevation);

    useEditor.getState().commit(result);
    const after = Uint8Array.from(useEditor.getState().sectors[sectorKey(A)]!.buffers.elevation);
    expect(Array.from(after)).not.toEqual(Array.from(before));

    useEditor.getState().undo();
    expect(
      Array.from(useEditor.getState().sectors[sectorKey(A)]!.buffers.elevation)
    ).toEqual(Array.from(before));
    expect(useEditor.getState().redoStack).toHaveLength(1);

    useEditor.getState().redo();
    expect(
      Array.from(useEditor.getState().sectors[sectorKey(A)]!.buffers.elevation)
    ).toEqual(Array.from(after));
  });

  it('a new edit clears the redo branch', () => {
    const gesture = () =>
      buildElevationOp(
        { plane: 0, wx: 50 * 48 + 10, wy: 50 * 48 + 10 },
        { mode: 'raise', radius: 1, falloff: 'constant', shape: 'square', strength: 1 },
        readSector
      );
    useEditor.getState().commit(gesture());
    useEditor.getState().undo();
    expect(useEditor.getState().redoStack).toHaveLength(1);
    useEditor.getState().commit(gesture());
    expect(useEditor.getState().redoStack).toHaveLength(0);
  });
});

describe('lock gating', () => {
  it('holds back a whole stroke that spills into an unheld sector', () => {
    seed({ [sectorKey(A)]: lock(A, ME, 'you') }); // B is free but not ours
    const beforeA = Uint8Array.from(
      useEditor.getState().sectors[sectorKey(A)]!.buffers.elevation
    );

    const result = buildElevationOp(
      { plane: 0, wx: 51 * 48 - 1, wy: 50 * 48 + 24 },
      { mode: 'raise', radius: 3, falloff: 'constant', shape: 'square', strength: 1 },
      readSector
    );
    expect(result.ops).toHaveLength(2);

    useEditor.getState().commit(result);
    const state = useEditor.getState();

    // Nothing applied -- not even the half we were entitled to write.
    expect(Array.from(state.sectors[sectorKey(A)]!.buffers.elevation)).toEqual(
      Array.from(beforeA)
    );
    expect(state.undoStack).toHaveLength(0);
    expect(state.notice?.kind).toBe('lock-required');
    if (state.notice?.kind !== 'lock-required') throw new Error('unreachable');
    expect(state.notice.sectors.map(sectorKey)).toEqual([sectorKey(B)]);
    expect(state.notice.pending).toHaveLength(2);
  });

  it('names the holder when the spill lands on someone else’s sector', () => {
    seed({
      [sectorKey(A)]: lock(A, ME, 'you'),
      [sectorKey(B)]: lock(B, THEM, 'mudlark')
    });

    useEditor.getState().commit(
      buildElevationOp(
        { plane: 0, wx: 51 * 48 - 1, wy: 50 * 48 + 24 },
        { mode: 'raise', radius: 3, falloff: 'constant', shape: 'square', strength: 1 },
        readSector
      )
    );

    const notice = useEditor.getState().notice;
    expect(notice?.kind).toBe('lock-required');
    if (notice?.kind !== 'lock-required') throw new Error('unreachable');
    expect(notice.heldBy[sectorKey(B)]).toBe('mudlark');
  });

  it('refuses an edit to a sector held by nobody', () => {
    seed({});
    useEditor.getState().commit(
      buildElevationOp(
        { plane: 0, wx: 50 * 48 + 24, wy: 50 * 48 + 24 },
        { mode: 'raise', radius: 1, falloff: 'constant', shape: 'square', strength: 1 },
        readSector
      )
    );
    expect(useEditor.getState().undoStack).toHaveLength(0);
    expect(useEditor.getState().notice?.kind).toBe('lock-required');
  });
});

describe('definition ops', () => {
  it('records only the changed fields and undoes exactly those', () => {
    seed({});
    useEditor.setState({
      config: {
        items: [
          {
            name: 'bronze sword',
            description: 'A sword.',
            command: '',
            sprite: 1,
            price: 10,
            stackable: false,
            special: false,
            equip: null,
            colour: null,
            untradeable: false,
            members: false
          }
        ],
        npcs: [],
        objects: [],
        wallObjects: [],
        roofs: [],
        tiles: [],
        textures: [],
        animations: [],
        spells: [],
        prayers: [],
        models: []
      }
    });

    useEditor
      .getState()
      .commitDefinitionEdit('items', 0, { colour: null }, { colour: 'transparent' });

    expect(useEditor.getState().config?.items[0]?.colour).toBe('transparent');
    expect(useEditor.getState().config?.items[0]?.name).toBe('bronze sword');

    useEditor.getState().undo();
    expect(useEditor.getState().config?.items[0]?.colour).toBeNull();
  });

  it('ignores an empty edit', () => {
    seed({});
    useEditor.getState().commitDefinitionEdit('items', 0, {}, {});
    expect(useEditor.getState().undoStack).toHaveLength(0);
  });
});
