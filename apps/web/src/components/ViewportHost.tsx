/**
 * Connects the store to the (renderer-agnostic) viewport.
 *
 * Keeping this separate from `src/scene/Viewport.tsx` is what makes the
 * renderer swap a one-component change: everything store-shaped lives here and
 * the viewport itself stays a pure props-in / events-out component.
 */

import { useCallback, useMemo } from 'react';
import { sectorKey } from '@rsc-editor/schema';
import type { SectorCoord } from '@rsc-editor/schema';
import { useEditor, lockStateFor } from '../state/editorStore.js';
import { applyGesture } from '../state/gesture.js';
import { Viewport, type ViewportLock, type ViewportSector } from '../scene/Viewport.js';
import { NoticeBanner } from './NoticeBanner.js';

export function ViewportHost() {
  const sectors = useEditor((s) => s.sectors);
  const activeSector = useEditor((s) => s.activeSector);
  const locks = useEditor((s) => s.locks);
  const peers = useEditor((s) => s.peers);
  const me = useEditor((s) => s.me);
  const world = useEditor((s) => s.world);
  const hoverTile = useEditor((s) => s.hoverTile);
  const selection = useEditor((s) => s.selection);
  const config = useEditor((s) => s.config);
  const activeTool = useEditor((s) => s.activeTool);
  const toolSettings = useEditor((s) => s.toolSettings);
  const showGrid = useEditor((s) => s.showGrid);
  const showSectorBorders = useEditor((s) => s.showSectorBorders);
  const showLockTint = useEditor((s) => s.showLockTint);
  const setHoverTile = useEditor((s) => s.setHoverTile);
  const setSelection = useEditor((s) => s.setSelection);
  const setViewCentre = useEditor((s) => s.setViewCentre);
  const ensureSector = useEditor((s) => s.ensureSector);

  const viewportSectors = useMemo(() => {
    const out: Record<string, ViewportSector> = {};
    for (const [key, s] of Object.entries(sectors)) {
      out[key] = { coord: s.coord, buffers: s.buffers, rev: s.rev };
    }
    return out;
  }, [sectors]);

  const lockFor = useCallback(
    (coord: SectorCoord): ViewportLock => {
      const { state, lock } = lockStateFor({ locks, me, world }, coord);
      if (!lock) return { state };
      const owner = lock.userId === me?.userId ? me : peers[lock.userId];
      return { state, ownerName: lock.displayName, ownerColour: owner?.colour ?? '#f2b23e' };
    },
    [locks, me, world, peers]
  );

  const brush =
    activeTool === 'elevation'
      ? { radius: toolSettings.elevation.radius, shape: toolSettings.elevation.shape }
      : activeTool === 'paint'
        ? { radius: toolSettings.paint.radius, shape: toolSettings.paint.shape }
        : activeTool === 'roof'
          ? { radius: toolSettings.roof.radius, shape: toolSettings.roof.shape }
          : { radius: 0, shape: 'square' as const };

  const regionDrag = activeTool === 'region' && toolSettings.region.mode === 'select';

  return (
    <div className="pane pane--center">
      <Viewport
        plane={activeSector?.plane ?? 0}
        sectors={viewportSectors}
        activeSector={activeSector}
        lockFor={lockFor}
        /* The 3D viewport meshes overlays, wall fills and roof heights out of
           the definition tables; the lanes alone cannot say what overlay 3 is. */
        config={config}
        hoverTile={hoverTile}
        selection={selection}
        brushRadius={brush.radius}
        brushShape={brush.shape}
        showGrid={showGrid}
        showSectorBorders={showSectorBorders}
        showLockTint={showLockTint}
        painting={activeTool !== 'select'}
        regionDrag={regionDrag}
        onPick={(tile, mods) => applyGesture(tile, mods)}
        onHover={(tile) => {
          setHoverTile(tile);
          // Where the map draws "you are here".
          //
          // The renderer seam has no camera-out event (src/scene/viewport-props.ts
          // is owned by the `renderer` agent and the orbit state lives inside
          // Viewport3D), so this publishes the POINTER, which is a real world tile
          // under the 3D view and is labelled as such on the map. `setViewCentre`
          // refuses to overwrite a `camera` reading, so the day the render loop
          // publishes a real pose this stops mattering with no change here.
          if (tile) {
            setViewCentre({
              plane: tile.plane,
              wx: tile.wx,
              wy: tile.wy,
              tilesAcross: null,
              source: 'pointer'
            });
          }
          // Stream in whatever the pointer wanders over, so a brush near a
          // boundary has its neighbour loaded before it needs it.
          if (tile) {
            const coord = {
              plane: tile.plane,
              x: Math.floor(tile.wx / 48),
              y: Math.floor(tile.wy / 48)
            };
            if (world?.present.includes(sectorKey(coord))) ensureSector(coord);
          }
        }}
        onDragRegion={setSelection}
      />
      <NoticeBanner />
    </div>
  );
}
