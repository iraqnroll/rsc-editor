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
  'region'
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
}

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  elevation: { mode: 'raise', radius: 3, falloff: 'smooth', shape: 'circle', strength: 0.5 },
  paint: { target: 'colour', colourIndex: 80, overlayIndex: 1, radius: 1, shape: 'circle' },
  wall: { edge: 'horizontal', wallId: 1, erase: false },
  roof: { roofId: 1, radius: 0, shape: 'square', erase: false },
  scenery: { mode: 'place', objectId: 0, direction: 0 },
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
