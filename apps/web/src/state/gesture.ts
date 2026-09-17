/**
 * Gesture dispatch: (active tool + settings + a tile the user clicked) -> ops.
 *
 * The viewport does not know what any tool does. It reports "the pointer is on
 * world tile (wx, wy) on plane p, with these modifiers" and calls in here. That
 * is the seam the real 3D viewport plugs into: whatever picks the tile — a
 * raycast against real terrain, or the placeholder's flat grid — the editing
 * behaviour is identical and lives here.
 */

import { parseSectorKey } from '@rsc-editor/schema';
import type { Lane, SectorCoord } from '@rsc-editor/schema';
import {
  buildElevationOp,
  buildPaintOp,
  buildRegionFillOp,
  buildRegionPasteOp,
  buildRoofOp,
  buildSceneryPlaceOp,
  buildSceneryRepairOp,
  buildSceneryRemoveOp,
  buildSceneryRotateOp,
  buildWallOp,
  copyRegion,
  normaliseRect,
  type BuildResult
} from '../ops/builders.js';
import type { WorldTile } from '../ops/coords.js';
import {
  DOOR_DIRECTION_BY_EDGE,
  buildEntityAdd,
  buildEntityRemove,
  entitiesAt,
  wanderAround
} from '../ops/entities.js';
import { useEditor } from './editorStore.js';

export interface GestureModifiers {
  /** Alt inverts a tool: raise<->lower, place<->erase. */
  alt: boolean;
  shift: boolean;
  /** Not the first pick of this drag: its edit joins the drag's undo step. */
  continued: boolean;
}

export function applyGesture(tile: WorldTile, mods: GestureModifiers): void {
  if (!mods.continued) useEditor.getState().startStroke();
  const state = useEditor.getState();
  const read = state.readSector;
  const loaded = (coord: SectorCoord) => read(coord) !== undefined;
  const s = state.toolSettings;

  switch (state.activeTool) {
    case 'select': {
      // Read-only: selecting a tile selects its sector, and whatever NPC, item
      // or door stands on it (or nothing, which clears the selection).
      const sx = Math.floor(tile.wx / 48);
      const sy = Math.floor(tile.wy / 48);
      state.setActiveSector({ plane: tile.plane, x: sx, y: sy });
      if (!mods.continued) {
        const first = entitiesAt(state.entities, tile)[0];
        state.selectEntity(first ? { sector: first.sector, id: first.id } : null);
      }
      return;
    }

    case 'elevation': {
      const mode =
        mods.alt && s.elevation.mode === 'raise'
          ? 'lower'
          : mods.alt && s.elevation.mode === 'lower'
            ? 'raise'
            : s.elevation.mode;
      state.commit(buildElevationOp(tile, { ...s.elevation, mode }, read));
      return;
    }

    case 'paint': {
      const value = s.paint.target === 'colour' ? s.paint.colourIndex : s.paint.overlayIndex;
      state.commit(
        buildPaintOp(
          tile,
          {
            radius: s.paint.radius,
            shape: s.paint.shape,
            lane: s.paint.target,
            value: mods.alt ? 0 : value
          },
          read
        )
      );
      return;
    }

    case 'wall': {
      const erase = s.wall.erase || mods.alt;
      if (s.wall.door) {
        // Server doors: one per edge. Dragging would stack a door on every
        // tile crossed, which is almost never meant, so a door is a click.
        if (mods.continued) return;
        const direction = DOOR_DIRECTION_BY_EDGE[s.wall.edge];
        const here = entitiesAt(state.entities, tile, 'door').filter(
          (e) => e.data.kind === 'door' && e.data.direction === direction
        );
        if (erase) {
          state.commit(buildEntityRemove(here), 'Remove door');
        } else if (here.length > 0) {
          state.selectEntity({ sector: here[0]!.sector, id: here[0]!.id });
        } else {
          state.commit(
            buildEntityAdd(tile, (i) => ({ kind: 'door', i, wallId: s.wall.wallId, direction }), loaded),
            'Place door'
          );
        }
        return;
      }
      state.commit(buildWallOp(tile, s.wall.edge, erase ? null : s.wall.wallId, read));
      return;
    }

    case 'npc':
    case 'item': {
      if (mods.continued) return;
      const kind = state.activeTool === 'npc' ? 'npc' : 'item';
      const here = entitiesAt(state.entities, tile, kind);
      const remove = mods.alt || s[state.activeTool].mode === 'remove';
      if (remove) {
        state.commit(buildEntityRemove(here), kind === 'npc' ? 'Remove NPC' : 'Remove item');
        return;
      }
      // Clicking an existing one selects it for the inspector; shift places
      // another on the same tile (the shipped lists do stack items).
      if (here.length > 0 && !mods.shift) {
        state.selectEntity({ sector: here[0]!.sector, id: here[0]!.id });
        return;
      }
      if (kind === 'npc') {
        const wander = wanderAround(tile, s.npc.wanderRadius);
        if (!wander) return;
        state.commit(
          buildEntityAdd(tile, (i) => ({ kind: 'npc', i, npcId: s.npc.npcId, wander }), loaded),
          'Place NPC'
        );
      } else {
        state.commit(
          buildEntityAdd(
            tile,
            (i) => ({
              kind: 'item',
              i,
              itemId: s.item.itemId,
              amount: Math.max(1, Math.floor(s.item.amount)),
              respawnMs: Math.max(0, Math.round(s.item.respawnSeconds * 1000))
            }),
            loaded
          ),
          'Place item'
        );
      }
      return;
    }

    case 'roof': {
      const erase = s.roof.erase || mods.alt;
      state.commit(
        buildRoofOp(tile, erase ? 0 : s.roof.roofId, s.roof.radius, s.roof.shape, read)
      );
      return;
    }

    case 'scenery': {
      // One object per click. Dragging would place a row of them, or spin the
      // one under the cursor once per tile crossed.
      if (mods.continued) return;
      const mode = mods.alt ? 'remove' : s.scenery.mode;
      const objects = state.config?.objects;
      if (!objects) {
        state.setNotice({ kind: 'info', message: 'Definitions are still loading.' });
        return;
      }
      if (mode === 'place') {
        state.commit(buildSceneryPlaceOp(tile, s.scenery.objectId, s.scenery.direction, read, objects));
      } else if (mode === 'rotate') {
        state.commit(buildSceneryRotateOp(tile, mods.shift ? 7 : 1, read, objects));
      } else {
        state.commit(buildSceneryRemoveOp(tile, read, objects));
      }
      return;
    }

    case 'region': {
      // Region select is a drag, handled by beginRegionDrag/endRegionDrag.
      // A plain click in fill/paste mode acts on the current selection.
      if (s.region.mode === 'fill') {
        const rect = state.selection;
        if (!rect) {
          state.setNotice({ kind: 'info', message: 'Drag a rectangle first, then fill.' });
          return;
        }
        state.commit(buildRegionFillOp(rect, s.region.fillLane, s.region.fillValue, read));
      } else if (s.region.mode === 'paste') {
        const clip = state.clipboard;
        if (!clip) {
          state.setNotice({ kind: 'info', message: 'Nothing copied yet.' });
          return;
        }
        state.commit(buildRegionPasteOp(tile, clip, s.region.pasteLanes, read));
      }
      return;
    }
  }
}

/** Region tool: lift the current selection into the clipboard. */
export function copySelection(): void {
  const state = useEditor.getState();
  if (!state.selection) {
    state.setNotice({ kind: 'info', message: 'Nothing selected.' });
    return;
  }
  const clip = copyRegion(normaliseRect(state.selection), state.readSector);
  if (!clip) {
    state.setNotice({
      kind: 'info',
      message: 'The selection covers sectors that are not loaded. Pan over them first.'
    });
    return;
  }
  state.setClipboard(clip);
  state.setNotice({
    kind: 'info',
    message: `Copied ${clip.width} x ${clip.height} tiles.`
  });
}

/** Region tool: fill the current selection with the configured lane value. */
export function fillSelection(lane: Lane, value: number): void {
  const state = useEditor.getState();
  if (!state.selection) return;
  state.commit(buildRegionFillOp(normaliseRect(state.selection), lane, value, state.readSector));
}

/**
 * Scenery tool: re-lay every object in the sectors you hold so the export
 * reads them back unchanged. For maps edited before the tool wrote whole
 * footprints; one undo step.
 */
export function repairHeldScenery(): void {
  const state = useEditor.getState();
  const objects = state.config?.objects;
  const mine = state.me?.userId;
  if (!objects || !mine) return;

  const held = Object.entries(state.locks)
    .filter(([, lock]) => lock.userId === mine)
    .map(([key]) => parseSectorKey(key));
  if (held.length === 0) {
    state.setNotice({ kind: 'info', message: 'Claim the sectors to repair first.' });
    return;
  }

  const merged: BuildResult = { ops: [], missing: [], touched: [], conflicts: [] };
  let fixed = 0;
  const dropped: string[] = [];
  for (const coord of held) {
    const repair = buildSceneryRepairOp(coord, state.readSector, objects);
    merged.ops.push(...repair.result.ops);
    merged.missing.push(...repair.result.missing);
    merged.touched.push(...repair.result.touched);
    fixed += repair.fixed;
    for (const d of repair.dropped) dropped.push(`object ${d.id} at (${d.wx}, ${d.wy})`);
  }
  if (merged.missing.length > 0) {
    state.commit(merged);
    return;
  }
  if (merged.ops.length === 0) {
    state.setNotice({ kind: 'info', message: `Scenery in ${held.length} held sector(s) is already consistent.` });
    return;
  }

  state.startStroke();
  state.commit(merged, 'Repair scenery');
  const parts = [`Repaired scenery in ${merged.touched.length} sector(s): ${fixed} object(s) re-laid.`];
  if (dropped.length > 0) {
    parts.push(`Removed ${dropped.length} that no longer fit: ${dropped.slice(0, 5).join(', ')}` +
      (dropped.length > 5 ? ', ...' : '') + '.');
  }
  useEditor.getState().setNotice({ kind: 'info', message: parts.join(' ') });
}
