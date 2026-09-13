/**
 * Camera poses. Pure arithmetic, so the presets can be asserted without a GPU.
 *
 * World render space: x = `renderX(tileX * 128)`, z = tileY * 128, y = height,
 * Y up, right-handed -- exactly what `packages/render` emits. `renderX` negates,
 * so +x is EAST and world x is negative; see `render-space.ts`.
 *
 * Nothing about the camera arithmetic itself depends on that. The mirror lives
 * in the geometry, not in the view: `orbitPose`, `panBy` and `flyForward` work
 * in render space and are unchanged by it. Only the functions here that turn a
 * TILE into a render position -- {@link sectorCentre}, {@link tileCentre} --
 * have to convert.
 */

import { SECTOR_WIDTH } from '@rsc-editor/schema';
import { TILE_SIZE, renderX } from '@rsc-editor/render';

export type CameraMode = 'orbit' | 'fly';

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

export interface OrbitState {
  /** look-at point, world render space */
  target: [number, number, number];
  /** distance from target, world units */
  distance: number;
  /**
   * degrees. 0 puts the camera at +z (south of the target) looking north, which
   * is {@link MAP_NORTH_YAW} -- read its comment before changing a preset.
   */
  yaw: number;
  /** degrees above the horizon; 90 is straight down */
  pitch: number;
}

/* -------------------------------------------------------------------------- */
/*  Agreeing with the world map                                               */
/* -------------------------------------------------------------------------- */

/**
 * The yaw that puts NORTH at the top of the screen and EAST on the right --
 * the world map's orientation, and the client's.
 *
 * At yaw 0 the camera sits at `target + (0, .., +z)` and looks back along -z.
 * Render z is `tileY * 128` and game y increases *southward*
 * (docs/CACHE-ASSET-API.md), so -z is north: the horizon at the top of the
 * screen is north.
 *
 * Screen right at this yaw is +x. Render x is `renderX(gameX * 128)`, i.e.
 * game x negated, and game x increases *westward*, so +x is east. The compass
 * directions are a right-handed frame in the space the geometry lives in --
 * (East, North, Up) = (+x, -z, +y), and x cross -z = +y -- which is what lets
 * one yaw satisfy both halves of the map's orientation at once.
 *
 * That agreement is not free and is not the camera's doing. It comes from
 * `RENDER_X_SIGN` in `packages/render/src/render-space.ts`, which mirrors the
 * x axis and reverses every triangle's winding to keep RSC's one-sided
 * surfaces showing the side they are meant to show. Before that flip the render
 * space was a reflection of the client's and no camera angle could have fixed
 * it; a camera can only rotate.
 */
export const MAP_NORTH_YAW = 0;

export const MIN_PITCH = 2;
export const MAX_PITCH = 89.5;
export const MIN_DISTANCE = TILE_SIZE;
export const MAX_DISTANCE = SECTOR_WIDTH * TILE_SIZE * 6;

/**
 * RuneScape Classic's own camera, as closely as a perspective camera gets.
 *
 * mudclient draws the world with
 * `scene.setCamera(x, -elevation, z, 912, cameraRotation * 4, 0, cameraZoom * 2)`
 * on a 1024-step circle, with `cameraZoom` sitting at 550 in normal play. 912 of
 * 1024 is 320.6 degrees, i.e. 39.4 degrees of downtilt, and the zoom argument is
 * the distance the camera is pushed back from the point it looks at: 1100 world
 * units, a little over eight tiles.
 *
 * CAVEAT, because this is the one place the viewport is not a port: the client
 * does not use a perspective matrix at all -- `Scene` projects with a fixed
 * integer view distance and its own scanline rasteriser -- so this preset frames
 * the same scene from the same place, and does not claim to reproduce its
 * projection pixel for pixel. It affects nothing about what the geometry *is*.
 */
export const IN_GAME_PITCH = (360 * (1024 - 912)) / 1024;
export const IN_GAME_DISTANCE = 550 * 2;

export function inGameOrbit(
  target: [number, number, number],
  yaw = MAP_NORTH_YAW
): OrbitState {
  return { target, distance: IN_GAME_DISTANCE, yaw, pitch: IN_GAME_PITCH };
}

/**
 * A whole sector in frame, looking north so the view agrees with the map.
 *
 * This used to sit at yaw 35 for a pleasanter three-quarter view. Squared up to
 * north, the sector grid and the world map read the same way round -- north up
 * and east right (see {@link MAP_NORTH_YAW}) -- which is worth more in an
 * editor than the nicer angle.
 */
export function overviewOrbit(target: [number, number, number]): OrbitState {
  return {
    target,
    distance: SECTOR_WIDTH * TILE_SIZE * 1.25,
    yaw: MAP_NORTH_YAW,
    pitch: 48
  };
}

/**
 * Fly mode reuses the orbit angles but not its pitch limits: an orbit camera
 * below the horizon is underground and one at exactly 90 degrees has an
 * undefined up vector, whereas flying you are allowed to look up at a roof.
 */
export const FLY_PITCH_LIMIT = 88;

export function clampFly(state: OrbitState): OrbitState {
  return {
    ...state,
    yaw: ((state.yaw % 360) + 360) % 360,
    pitch: Math.min(FLY_PITCH_LIMIT, Math.max(-FLY_PITCH_LIMIT, state.pitch))
  };
}

export function clampOrbit(state: OrbitState): OrbitState {
  return {
    target: state.target,
    distance: Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, state.distance)),
    yaw: ((state.yaw % 360) + 360) % 360,
    pitch: Math.min(MAX_PITCH, Math.max(MIN_PITCH, state.pitch))
  };
}

export function orbitPose(state: OrbitState): CameraPose {
  const pitch = (state.pitch * Math.PI) / 180;
  const yaw = (state.yaw * Math.PI) / 180;
  const horizontal = Math.cos(pitch) * state.distance;

  return {
    position: [
      state.target[0] + Math.sin(yaw) * horizontal,
      state.target[1] + Math.sin(pitch) * state.distance,
      state.target[2] + Math.cos(yaw) * horizontal
    ],
    target: state.target
  };
}

/** World render-space centre of a sector, at a given ground height. */
export function sectorCentre(
  sx: number,
  sy: number,
  height = 0
): [number, number, number] {
  return [
    renderX((sx + 0.5) * SECTOR_WIDTH * TILE_SIZE),
    height,
    (sy + 0.5) * SECTOR_WIDTH * TILE_SIZE
  ];
}

/** World render-space centre of a tile. */
export function tileCentre(wx: number, wy: number, height = 0): [number, number, number] {
  return [renderX((wx + 0.5) * TILE_SIZE), height, (wy + 0.5) * TILE_SIZE];
}
