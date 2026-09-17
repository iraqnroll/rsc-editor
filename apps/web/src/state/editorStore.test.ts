/**
 * The store's job in one sentence: no edit reaches a lane except through an op,
 * and no op reaches a lane you do not hold. These tests pin both.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SECTOR_WIDTH, emptySectorBuffers, sectorKey } from '@rsc-editor/schema';
import type { Lock, SectorCoord } from '@rsc-editor/schema';
import { useEditor } from './editorStore.js';
import { buildElevationOp } from '../ops/builders.js';
import { buildEntityAdd, entitiesAt } from '../ops/entities.js';

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

/* ------------------------------------------------------- project choice -- */

/**
 * The client will resolve a project on its own -- pinned, last opened, or
 * simply the first the server listed. With one project that is right; with two
 * it silently decides for you. These pin the decision the store makes instead.
 */
describe('choosing a project', () => {
  function apiWith(projects: Array<{ id: string; name: string }>) {
    const used: string[] = [];
    const api = {
      mode: 'live' as const,
      link: 'offline' as const,
      listProjects: async () => projects.map((p) => ({ ...p, slug: p.id, headSeq: 0 })),
      useProject: (id: string) => used.push(id),
      connect: async () => {
        throw new Error('connect must not be reached while a choice is pending');
      },
      subscribe: () => () => undefined,
      subscribeLink: () => () => undefined,
      disconnect: () => undefined
    };
    return { api, used };
  }

  beforeEach(() => {
    useEditor.setState({ connection: 'idle', error: null });
  });

  it('stops and asks when the account has more than one', async () => {
    const { api, used } = apiWith([
      { id: 'a', name: 'Gielinor' },
      { id: 'b', name: 'Blank Canvas' }
    ]);
    useEditor.setState({ api: api as never });

    await useEditor.getState().connect();

    expect(useEditor.getState().connection).toBe('choose-project');
    // Nothing was opened on the user's behalf.
    expect(used).toEqual([]);
  });

  it('says "no project" rather than asking, when there is nothing to choose', async () => {
    const { api } = apiWith([]);
    useEditor.setState({ api: api as never });

    await useEditor.getState().connect();

    expect(useEditor.getState().connection).toBe('no-project');
  });

  it('puts the question back on screen without signing out', () => {
    const { api } = apiWith([{ id: 'a', name: 'One' }]);
    useEditor.setState({
      api: api as never,
      connection: 'ready',
      world: { present: [], box: null } as never,
      sectors: { '0/50/50': {} as never }
    });

    useEditor.getState().chooseProject();

    const state = useEditor.getState();
    expect(state.connection).toBe('choose-project');
    // Everything scoped to the old world is gone, not left looking stale.
    expect(state.world).toBeNull();
    expect(state.sectors).toEqual({});
  });
});

describe('entities', () => {
  beforeEach(() => {
    seed({ [sectorKey(A)]: lock(A, ME, 'you') });
    useEditor.setState({
      entities: {},
      selectedEntity: null,
      // earlier tests leave a narrower stub installed
      api: { submitOps: async () => ({ ok: true, seq: 1 }) } as never
    });
  });

  const npc = (tile: { plane: number; wx: number; wy: number }) =>
    buildEntityAdd(
      tile,
      (i) => ({ kind: 'npc', i, npcId: 1, wander: { minX: 0, maxX: 1, minY: 0, maxY: 1 } }),
      () => true
    );

  it('places, undoes and redoes a spawn like any other edit', () => {
    const tile = { plane: 0, wx: 50 * 48 + 2, wy: 50 * 48 + 2 };
    useEditor.getState().commit(npc(tile), 'Place NPC');
    expect(entitiesAt(useEditor.getState().entities, tile)).toHaveLength(1);
    expect(useEditor.getState().undoStack.at(-1)?.label).toBe('Place NPC');

    const [placed] = entitiesAt(useEditor.getState().entities, tile);
    useEditor.getState().selectEntity({ sector: placed!.sector, id: placed!.id });
    useEditor.getState().undo();
    expect(entitiesAt(useEditor.getState().entities, tile)).toEqual([]);
    // a removed entity cannot stay selected
    expect(useEditor.getState().selectedEntity).toBeNull();

    useEditor.getState().redo();
    expect(entitiesAt(useEditor.getState().entities, tile)).toHaveLength(1);
  });

  it('holds back a placement in a sector you do not hold', () => {
    const tile = { plane: 0, wx: 51 * 48 + 2, wy: 50 * 48 + 2 };
    useEditor.getState().commit(npc(tile));
    expect(entitiesAt(useEditor.getState().entities, tile)).toEqual([]);
    expect(useEditor.getState().notice?.kind).toBe('lock-required');
  });
});

