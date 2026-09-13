/**
 * Gesture dispatch: (active tool + settings + a tile the user clicked) -> ops.
 *
 * The viewport does not know what any tool does. It reports "the pointer is on
 * world tile (wx, wy) on plane p, with these modifiers" and calls in here. That
 * is the seam the real 3D viewport plugs into: whatever picks the tile — a
 * raycast against real terrain, or the placeholder's flat grid — the editing
 * behaviour is identical and lives here.
 */

import type { Lane } from '@rsc-editor/schema';
import {
  buildElevationOp,
  buildPaintOp,
  buildRegionFillOp,
  buildRegionPasteOp,
  buildRoofOp,
  buildSceneryPlaceOp,
  buildSceneryRemoveOp,
  buildSceneryRotateOp,
  buildWallOp,
  copyRegion,
  normaliseRect
} from '../ops/builders.js';
import type { WorldTile } from '../ops/coords.js';
import { useEditor } from './editorStore.js';

export interface GestureModifiers {
  /** Alt inverts a tool: raise<->lower, place<->erase. */
  alt: boolean;
  shift: boolean;
}

export function applyGesture(tile: WorldTile, mods: GestureModifiers): void {
  const state = useEditor.getState();
  const read = state.readSector;
  const s = state.toolSettings;

  switch (state.activeTool) {
    case 'select': {
      // Read-only: selecting a tile selects its sector.
      const sx = Math.floor(tile.wx / 48);
      const sy = Math.floor(tile.wy / 48);
      state.setActiveSector({ plane: tile.plane, x: sx, y: sy });
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
      state.commit(buildWallOp(tile, s.wall.edge, erase ? 0 : s.wall.wallId, read));
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
      const mode = mods.alt ? 'remove' : s.scenery.mode;
      if (mode === 'place') {
        state.commit(buildSceneryPlaceOp(tile, s.scenery.objectId, s.scenery.direction, read));
      } else if (mode === 'rotate') {
        const current = read({ plane: tile.plane, x: Math.floor(tile.wx / 48), y: Math.floor(tile.wy / 48) });
        const i = (tile.wx % 48) * 48 + (tile.wy % 48);
        const dir = ((current?.direction[i] ?? 0) + (mods.shift ? 7 : 1)) & 7;
        state.commit(buildSceneryRotateOp(tile, dir, read));
      } else {
        state.commit(buildSceneryRemoveOp(tile, read));
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
