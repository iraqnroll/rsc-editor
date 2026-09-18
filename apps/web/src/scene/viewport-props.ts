/**
 * ============================================================================
 *  THE RENDERER SEAM -- the props-in / events-out contract.
 * ============================================================================
 *
 * Every editing tool in the app is built on this shape, and nothing about *what
 * an edit means* lives in the viewport: that is `src/state/gesture.ts`. So the
 * viewport can be a flat 2D read of the lanes or a client-accurate 3D scene
 * without a single tool changing behaviour.
 *
 *   props in   -- sector lanes, the active sector, lock states, overlay
 *                 toggles, brush radius, hovered tile. All plain data; no store
 *                 access.
 *   events out -- `onPick(worldTile, modifiers)` when the user commits a click,
 *                 `onHover(worldTile | null)` as the pointer moves,
 *                 `onDragRegion(rect)` for rectangle selection.
 *
 * Fields may be ADDED here (optional, so existing callers keep compiling); they
 * may not be renamed or removed.
 */

import type { RscConfig, SectorBuffers, SectorCoord } from '@rsc-editor/schema';
import type { WorldTile } from '../ops/coords.js';
import type { RegionRect } from '../ops/builders.js';

export interface ViewportSector {
  coord: SectorCoord;
  buffers: SectorBuffers;
  rev: number;
}

export interface ViewportLock {
  /** 'free' | 'mine' | 'theirs' */
  state: 'free' | 'mine' | 'theirs' | 'absent';
  ownerName?: string;
  ownerColour?: string;
}

export interface ViewportProps {
  plane: number;
  /** Loaded sectors, keyed by sectorKey(). */
  sectors: Record<string, ViewportSector>;
  activeSector: SectorCoord | null;
  lockFor: (coord: SectorCoord) => ViewportLock;
  hoverTile: WorldTile | null;
  selection: RegionRect | null;
  brushRadius: number;
  brushShape: 'circle' | 'square';
  showGrid: boolean;
  showSectorBorders: boolean;
  showLockTint: boolean;
  /** true while the active tool writes; drives the cursor and the brush ring. */
  painting: boolean;
  /** true for the region tool: a left-drag draws a rectangle instead of painting. */
  regionDrag: boolean;
  /**
   * `continued` is true for every pick after the first in one drag, so the
   * whole drag can be one undo step.
   */
  onPick: (tile: WorldTile, mods: { alt: boolean; shift: boolean; continued: boolean }) => void;
  onHover: (tile: WorldTile | null) => void;
  onDragRegion: (rect: RegionRect | null) => void;
  /**
   * The Group tool's drop preview: while set, the cursor is drawn as this
   * rectangle (relative to the hovered tile) instead of the brush.
   */
  ghost?: ((hover: WorldTile) => RegionRect) | null;

  /* ------------------------------------------------------------ additions -- */

  /**
   * Cache definitions.
   *
   * ADDED for the 3D viewport, optional so every existing caller still
   * compiles. Terrain overlays, wall fills and roof heights are all *definition*
   * lookups -- `config.tiles`, `config.wallObjects`, `config.roofs` -- so the
   * lanes alone cannot be meshed. Without it the scene shows a loading state
   * rather than inventing fills.
   */
  config?: RscConfig | null;

  /**
   * NPC spawns, ground items and server doors to mark, in world tiles.
   * ADDED for entity placement; optional like the rest.
   */
  entities?: ViewportEntity[];

  /** Bumped when the asset library changes; the scene reloads its textures and models. */
  libraryVersion?: number;
}

export interface ViewportEntity {
  id: string;
  kind: 'npc' | 'item' | 'door';
  plane: number;
  wx: number;
  wy: number;
  /** doors: 0 horizontal, 1 vertical, 2 "/", 3 "\" */
  direction?: number;
  /** doors: the wall object's height, in render units */
  height?: number;
  selected: boolean;
  /** NPCs: the definition index, for the picture */
  npcId?: number;
  /** items: the definition index, for the picture */
  itemId?: number;
  /** NPCs: the wander box in world tiles, inclusive */
  wander?: RegionRect;
}
