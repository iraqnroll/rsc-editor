/**
 * The tool registry.
 *
 * A tool is metadata plus a settings bag. It owns no state and performs no
 * edits: the store turns (active tool + settings + gesture) into ops via
 * `src/ops/builders.ts`. Adding a tool is an entry here, a settings type, and
 * a case in `src/state/gesture.ts`.
 */

import type { Lane } from '@rsc-editor/schema';
import type {
  BrushShape,
  ElevationMode,
  Falloff,
  WallEdge
} from '../ops/builders.js';

export const TOOL_IDS = [
  'select',
  'elevation',
  'paint',
  'wall',
  'roof',
  'scenery',
  'region',
  'npc',
  'item',
  'hole',
  'eraser',
  'group'
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export interface ToolMeta {
  id: ToolId;
  label: string;
  glyph: string;
  hotkey: string;
  /** Shown in the inspector header and the shortcut sheet. */
  blurb: string;
  /** false for tools that only read — they work without a sector lock. */
  mutates: boolean;
}

export const TOOLS: readonly ToolMeta[] = [
  {
    id: 'select',
    label: 'Select',
    glyph: '↖',
    hotkey: '1',
    blurb: 'Inspect tiles and pick sectors. Never writes.',
    mutates: false
  },
  {
    id: 'elevation',
    label: 'Elevation',
    glyph: '⛰',
    hotkey: '2',
    blurb: 'Raise, lower, smooth or flatten terrain height.',
    mutates: true
  },
  {
    id: 'paint',
    label: 'Paint',
    glyph: '\u{1F58C}',
    hotkey: '3',
    blurb: 'Terrain colour ramp index, or ground overlay / tile type.',
    mutates: true
  },
  {
    id: 'wall',
    label: 'Walls',
    glyph: '▓',
    hotkey: '4',
    blurb: 'Place or remove boundary objects on tile edges.',
    mutates: true
  },
  {
    id: 'roof',
    label: 'Roof',
    glyph: '⏶',
    hotkey: '5',
    blurb: 'Set the roof object over enclosed areas.',
    mutates: true
  },
  {
    id: 'scenery',
    label: 'Scenery',
    glyph: '\u{1F332}',
    hotkey: '6',
    blurb: 'Place, rotate and delete game objects.',
    mutates: true
  },
  {
    id: 'region',
    label: 'Region',
    glyph: '⬚',
    hotkey: '7',
    blurb: 'Rectangle select, fill, copy and paste.',
    mutates: true
  },
  {
    id: 'npc',
    label: 'NPCs',
    glyph: '☺',
    hotkey: '8',
    blurb: 'Place and remove NPC spawns, with the box they wander in. Server-side.',
    mutates: true
  },
  {
    id: 'item',
    label: 'Items',
    glyph: '◆',
    hotkey: '9',
    blurb: 'Place and remove ground items and their respawn time. Server-side.',
    mutates: true
  },
  {
    id: 'hole',
    label: 'Holes',
    glyph: '◯',
    hotkey: '0',
    blurb: 'Punch see-through or black holes in the ground. Alt fills them back in.',
    mutates: true
  },
  {
    id: 'eraser',
    label: 'Eraser',
    glyph: '⌫',
    hotkey: 'x',
    blurb: 'Clear scenery, NPCs, items, doors, walls and overlays under the brush.',
    mutates: true
  },
  {
    id: 'group',
    label: 'Group',
    glyph: '⧉',
    hotkey: 'v',
    blurb: 'Select walls, scenery, roofs, NPCs, items and doors in a rectangle; move or copy them.',
    mutates: true
  }
];

export const TOOL_BY_ID: Record<ToolId, ToolMeta> = Object.fromEntries(
  TOOLS.map((t) => [t.id, t])
) as Record<ToolId, ToolMeta>;

/* -------------------------------------------------------------- settings -- */

export interface ElevationSettings {
  mode: ElevationMode;
  radius: number;
  falloff: Falloff;
  shape: BrushShape;
  strength: number;
}

export interface PaintSettings {
  target: 'colour' | 'overlay';
  colourIndex: number;
  overlayIndex: number;
  radius: number;
  shape: BrushShape;
}

export interface WallSettings {
  edge: WallEdge;
  wallId: number;
  erase: boolean;
  /**
   * Place a door the game SERVER spawns, rather than writing the wall lane.
   * Doors in RSC are server entities over a hidden placeholder in the map.
   */
  door: boolean;
}

export interface RoofSettings {
  roofId: number;
  radius: number;
  shape: BrushShape;
  erase: boolean;
}

export interface ScenerySettings {
  mode: 'place' | 'rotate' | 'remove';
  objectId: number;
  direction: number;
}

export interface NpcSettings {
  /** place, or remove every NPC on the clicked tile */
  mode: 'place' | 'remove';
  npcId: number;
  /** half-width of the wander box a new spawn gets, in tiles */
  wanderRadius: number;
}

export interface ItemSettings {
  mode: 'place' | 'remove';
  itemId: number;
  amount: number;
  respawnSeconds: number;
}

export interface HoleSettings {
  /** lane value of a hole overlay (a tile definition with type 'hole') */
  overlay: number;
  radius: number;
  shape: BrushShape;
}

export interface EraserSettings {
  radius: number;
  shape: BrushShape;
  scenery: boolean;
  npcs: boolean;
  items: boolean;
  doors: boolean;
  walls: boolean;
  /** overlay paint, holes included */
  overlay: boolean;
  /** off by default: a roof is invisible from inside, so it is easy to punch through by accident */
  roofs: boolean;
}

export interface GroupSettings {
  /** select: drag a rectangle; move / copy: click to drop the group there */
  mode: 'select' | 'move' | 'copy';
  walls: boolean;
  scenery: boolean;
  roofs: boolean;
  npcs: boolean;
  items: boolean;
  doors: boolean;
}

export interface RegionSettings {
  mode: 'select' | 'fill' | 'paste';
  fillLane: Lane;
  fillValue: number;
  /** Which lanes a paste writes. Unticked lanes are left alone. */
  pasteLanes: Lane[];
}

export interface ToolSettings {
  elevation: ElevationSettings;
  paint: PaintSettings;
  wall: WallSettings;
  roof: RoofSettings;
  scenery: ScenerySettings;
  region: RegionSettings;
  npc: NpcSettings;
  item: ItemSettings;
  hole: HoleSettings;
  eraser: EraserSettings;
  group: GroupSettings;
}

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  elevation: { mode: 'raise', radius: 3, falloff: 'smooth', shape: 'circle', strength: 0.5 },
  paint: { target: 'colour', colourIndex: 80, overlayIndex: 1, radius: 1, shape: 'circle' },
  wall: { edge: 'horizontal', wallId: 0, erase: false, door: false },
  roof: { roofId: 1, radius: 0, shape: 'square', erase: false },
  scenery: { mode: 'place', objectId: 0, direction: 0 },
  npc: { mode: 'place', npcId: 0, wanderRadius: 5 },
  item: { mode: 'place', itemId: 0, amount: 1, respawnSeconds: 60 },
  hole: { overlay: 8, radius: 0, shape: 'square' },
  eraser: {
    radius: 0,
    shape: 'square',
    scenery: true,
    npcs: true,
    items: true,
    doors: true,
    walls: true,
    overlay: true,
    roofs: false
  },
  group: { mode: 'select', walls: true, scenery: true, roofs: true, npcs: true, items: true, doors: true },
  region: {
    mode: 'select',
    fillLane: 'colour',
    fillValue: 80,
    pasteLanes: [
      'elevation',
      'colour',
      'overlay',
      'direction',
      'wallsVertical',
      'wallsHorizontal',
      'wallsRoof',
      'wallsDiagonal'
    ]
  }
};
