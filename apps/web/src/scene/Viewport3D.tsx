/**
 * The client-accurate 3D viewport.
 *
 * All geometry comes from `@rsc-editor/render` -- `buildSectorMesh()` returns
 * positions, baked vertex colours, uvs and indices as typed arrays and those
 * arrays become BufferAttributes unchanged. Nothing here re-derives a
 * triangulation, a colour or a normal.
 *
 * ============================================================================
 *  THERE ARE NO LIGHTS IN THIS SCENE, AND THAT IS CORRECT.
 * ============================================================================
 *
 * RSC has its own integer lighting model (ambient/diffuse against a fixed
 * (-50, -10, -50) direction, per-face for walls, per-vertex for terrain and
 * roofs) and `packages/render` reproduces it, baking the result into the colour
 * attribute. The material is therefore `MeshBasicMaterial` with `vertexColors`.
 * Adding a `DirectionalLight` would double-light every surface: it would look
 * nicer, and it would not be what the game draws. Same reason `side` is
 * `FrontSide`: RSC surfaces are one-sided, which is why you can see into a
 * building from above and why a roof vanishes from underneath.
 *
 * Colour management is off (linear output, no tone mapping, `NoColorSpace` on
 * the atlas) so that `texel * vertexColour` happens on the same 8-bit sRGB
 * values the client multiplies. See `atlas-texture.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ColorManagement,
  DoubleSide,
  FrontSide,
  LinearSRGBColorSpace,
  Mesh,
  NoToneMapping,
  Raycaster,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Texture
} from 'three';
import { SECTOR_WIDTH, sectorKey } from '@rsc-editor/schema';
import { TILE_SIZE } from '@rsc-editor/render';
import type { WorldTile } from '../ops/coords.js';
import { ATLAS_ALPHA_TEST, loadAtlas, type ResolvedAtlas } from './atlas-texture.js';
import {
  clampFly,
  clampOrbit,
  inGameOrbit,
  MAX_DISTANCE,
  orbitPose,
  overviewOrbit,
  sectorCentre,
  type CameraMode,
  type OrbitState
} from './camera.js';
import {
  buildBrushOutline,
  buildRectOutline,
  buildSectorBorder,
  buildTileGrid,
  clampWindow,
  sectorTintTransform
} from './overlay-geometry.js';
import { sameTile, tileOfFace, tileOfGroundPlane, worldTileAt } from './picking.js';
import {
  SectorGeometryCache,
  SECTOR_SPAN,
  WorldHeights,
  type SectorGeometrySet,
  type SectorSource
} from './sector-geometry.js';
import type { ViewportProps } from './viewport-props.js';

// The vertex colours are final sRGB values, not linear working-space colours.
// See the header.
ColorManagement.enabled = false;

/** Tiles of grid drawn around the camera target. A grid is a precision aid. */
const GRID_WINDOW = 64;

/** Sectors meshed per frame. Meshing a dense sector costs ~100ms. */
const MESH_BUDGET = 1;

/* ========================================================================== */
/*  Scene contents                                                            */
/* ========================================================================== */

interface PickResult {
  tile: WorldTile | null;
  /** render-space point the ray hit, for the badge readout */
  point: Vector3 | null;
}

interface SceneApi {
  pick(ndcX: number, ndcY: number): PickResult;
  /** camera basis, so the host's pan/orbit handlers can work in view space */
  camera: PerspectiveCamera | null;
}

interface SceneProps extends ViewportProps {
  sectorList: Map<string, SectorSource>;
  cache: SectorGeometryCache;
  atlas: Texture | null;
  orbitRef: React.MutableRefObject<OrbitState>;
  modeRef: React.MutableRefObject<CameraMode>;
  flyRef: React.MutableRefObject<Set<string>>;
  apiRef: React.MutableRefObject<SceneApi | null>;
  onBuilt: () => void;
  onPlates: (plates: Plate[]) => void;
  version: number;
}

interface Plate {
  key: string;
  x: number;
  y: number;
  name: string;
  colour: string;
}

function SceneContents(props: SceneProps) {
  const { cache, atlas, orbitRef, modeRef, flyRef, apiRef, onBuilt, onPlates } = props;
  const three = useThree();
  const camera = three.camera as PerspectiveCamera;
  // Keyed, not an array rebuilt during render: ref callbacks only fire on
  // mount/unmount, so clearing an array every render would empty it and never
  // refill it -- picking would silently stop working after the first re-render.
  const terrainMeshes = useRef(new Map<string, Mesh>());
  const raycaster = useMemo(() => new Raycaster(), []);
  const plateClock = useRef(0);
  const lastPlates = useRef('');

  /* ---------------------------------------------------------- the camera -- */

  useFrame((_, delta) => {
    if (modeRef.current === 'fly') {
      applyFly(camera, flyRef.current, delta, orbitRef);
    } else {
      const pose = orbitPose(orbitRef.current);
      camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
      camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    }
    camera.updateMatrixWorld();
  });

  /* ------------------------------------------------- incremental meshing -- */

  useFrame(() => {
    if (cache.drain(MESH_BUDGET)) onBuilt();
  });

  /* ------------------------------------------------------------- picking -- */

  const pick = useCallback(
    (ndcX: number, ndcY: number): PickResult => {
      raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);
      const hits = raycaster.intersectObjects([...terrainMeshes.current.values()], false);
      const hit = hits[0];

      if (hit) {
        const sector = hit.object.userData.sector as SectorGeometrySet | undefined;
        const tile = sector ? tileOfFace(sector, hit.faceIndex) : null;
        if (tile) return { tile, point: hit.point };
        // Hit a terrain triangle that belongs to no tile (a bridge deck laid by
        // a neighbour): fall back to the position rather than dropping the pick.
        return {
          tile: worldTileAt(props.plane, hit.point.x, hit.point.z),
          point: hit.point
        };
      }

      // No ground: an upper storey, or a gap. See `tileOfGroundPlane`.
      const tile = tileOfGroundPlane(props.plane, raycaster.ray.origin, raycaster.ray.direction);
      return { tile, point: null };
    },
    [camera, raycaster, props.plane]
  );

  useEffect(() => {
    apiRef.current = { pick, camera };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, pick, camera]);

  /* ---------------------------------------------------------- nameplates -- */

  useFrame((_, delta) => {
    plateClock.current += delta;
    if (plateClock.current < 0.1) return;
    plateClock.current = 0;

    const plates: Plate[] = [];
    for (const entry of cache.list()) {
      const lock = props.lockFor(entry.coord);
      if (lock.state !== 'theirs' || !lock.ownerName) continue;

      const centre = sectorCentre(entry.coord.x, entry.coord.y, 260);
      const world = new Vector3(centre[0], centre[1], centre[2]);

      // `project()` mirrors points that are BEHIND the camera onto the screen,
      // so a plate for a sector at your back would appear in front of you.
      // Reject on the view direction first.
      const forward = new Vector3();
      camera.getWorldDirection(forward);
      if (world.clone().sub(camera.position).dot(forward) <= 0) continue;

      const projected = world.project(camera);
      if (projected.z > 1) continue;

      plates.push({
        key: sectorKey(entry.coord),
        x: Math.round(((projected.x + 1) / 2) * three.size.width),
        y: Math.round(((1 - projected.y) / 2) * three.size.height),
        name: lock.ownerName,
        colour: lock.ownerColour ?? '#f2b23e'
      });
    }

    // This runs ten times a second; an unconditional setState would re-render
    // the whole viewport that often for no change.
    const signature = plates.map((p) => `${p.key}:${p.x}:${p.y}:${p.name}`).join('|');
    if (signature === lastPlates.current) return;
    lastPlates.current = signature;
    onPlates(plates);
  });

  /* -------------------------------------------------------------- render -- */

  return (
    <>
      {cache.list().map((set) => {
        // Keyed on the signature as well as the sector, so a re-meshed sector's
        // new mesh can never be evicted by its predecessor's unmount.
        const id = `${set.key}:${set.signature}`;
        return (
          <SectorLayer
            key={id}
            set={set}
            atlas={atlas}
            register={(mesh) => {
              if (mesh) terrainMeshes.current.set(id, mesh);
              else terrainMeshes.current.delete(id);
            }}
          />
        );
      })}

      <Overlays {...props} />
    </>
  );
}

/* ========================================================================== */
/*  One sector's three layers                                                 */
/* ========================================================================== */

function SectorLayer({
  set,
  atlas,
  register
}: {
  set: SectorGeometrySet;
  atlas: Texture | null;
  register: (mesh: Mesh | null) => void;
}) {
  // `alphaTest` WITHOUT `transparent`. A cutout is a hole, not a translucent
  // surface: leaving the material opaque keeps it in the depth-sorted opaque
  // queue and discards the cut texels in the shader, which is exactly what the
  // client's `clearRect` cutouts do. Turning `transparent` on as well would move
  // every sector into the back-to-front transparent pass and make walls sort
  // against each other for no reason.
  const material = (
    <meshBasicMaterial
      vertexColors
      map={atlas}
      side={FrontSide}
      alphaTest={ATLAS_ALPHA_TEST}
      toneMapped={false}
    />
  );

  return (
    <group position={[set.originX, 0, set.originZ]}>
      {set.terrain && (
        <mesh
          ref={(mesh) => {
            // The picker reads `userData.sector` to turn a faceIndex into a
            // tile; see picking.ts.
            if (mesh) mesh.userData.sector = set;
            register(mesh);
          }}
          geometry={set.terrain}
        >
          {material}
        </mesh>
      )}
      {set.walls && <mesh geometry={set.walls}>{material}</mesh>}
      {set.roofs && <mesh geometry={set.roofs}>{material}</mesh>}
    </group>
  );
}

/* ========================================================================== */
/*  Editor overlays                                                           */
/* ========================================================================== */

function Overlays(props: SceneProps) {
  const {
    sectorList,
    plane,
    activeSector,
    lockFor,
    hoverTile,
    selection,
    brushRadius,
    brushShape,
    showGrid,
    showSectorBorders,
    showLockTint,
    painting,
    version
  } = props;

  // One height reader per render. It memoises a LandscapeView per sector, so
  // every overlay below shares the same eight-neighbour lookups.
  const heights = useMemo(
    () => new WorldHeights(sectorList, plane),
    [sectorList, plane, version]
  );

  const gridGeometry = useMemo(() => {
    if (!showGrid || !activeSector) return null;
    const window = clampWindow(
      {
        x0: activeSector.x * SECTOR_WIDTH,
        y0: activeSector.y * SECTOR_WIDTH,
        x1: (activeSector.x + 1) * SECTOR_WIDTH,
        y1: (activeSector.y + 1) * SECTOR_WIDTH
      },
      GRID_WINDOW
    );
    return lineGeometry(buildTileGrid(heights, window));
  }, [showGrid, activeSector?.x, activeSector?.y, heights]);

  const borderGeometries = useMemo(() => {
    if (!showSectorBorders) return [];
    return [...sectorList.values()].map((sector) => ({
      key: sectorKey(sector.coord),
      coord: sector.coord,
      geometry: lineGeometry(buildSectorBorder(heights, sector.coord.x, sector.coord.y))
    }));
  }, [showSectorBorders, sectorList, heights]);

  const selectionGeometry = useMemo(() => {
    if (!selection || selection.plane !== plane) return null;
    return lineGeometry(
      buildRectOutline(heights, selection.x0, selection.y0, selection.x1, selection.y1)
    );
  }, [selection, plane, heights]);

  const brushGeometry = useMemo(() => {
    if (!hoverTile || hoverTile.plane !== plane) return null;
    return lineGeometry(
      buildBrushOutline(heights, hoverTile.wx, hoverTile.wy, brushRadius, brushShape)
    );
  }, [hoverTile, plane, brushRadius, brushShape, heights]);

  useDisposeOnChange(gridGeometry);
  useDisposeOnChange(selectionGeometry);
  useDisposeOnChange(brushGeometry);
  useDisposeAllOnChange(borderGeometries);

  return (
    <>
      {gridGeometry && (
        <lineSegments geometry={gridGeometry}>
          <lineBasicMaterial color="#ffffff" transparent opacity={0.09} toneMapped={false} />
        </lineSegments>
      )}

      {borderGeometries.map(({ key, coord, geometry }) => {
        const lock = lockFor(coord);
        const isActive =
          activeSector && activeSector.x === coord.x && activeSector.y === coord.y;
        const colour = isActive
          ? '#4c9aff'
          : lock.state === 'theirs'
            ? (lock.ownerColour ?? '#f2b23e')
            : '#ffffff';
        return (
          <lineSegments key={key} geometry={geometry}>
            <lineBasicMaterial
              color={colour}
              transparent
              opacity={isActive ? 0.9 : lock.state === 'theirs' ? 0.7 : 0.22}
              toneMapped={false}
            />
          </lineSegments>
        );
      })}

      {showLockTint &&
        [...sectorList.values()].map((sector) => {
          const lock = lockFor(sector.coord);
          if (lock.state === 'free' || lock.state === 'absent') return null;
          const { x, z, size } = sectorTintTransform(sector.coord.x, sector.coord.y);
          return (
            <mesh
              key={`tint-${sectorKey(sector.coord)}`}
              position={[x, 900, z]}
              rotation={[-Math.PI / 2, 0, 0]}
            >
              <planeGeometry args={[size, size]} />
              <meshBasicMaterial
                color={new Color(lock.ownerColour ?? '#4c9aff')}
                transparent
                opacity={lock.state === 'mine' ? 0.06 : 0.14}
                depthWrite={false}
                side={DoubleSide}
                toneMapped={false}
              />
            </mesh>
          );
        })}

      {selectionGeometry && (
        <lineSegments geometry={selectionGeometry}>
          <lineBasicMaterial color="#4c9aff" toneMapped={false} />
        </lineSegments>
      )}

      {brushGeometry && (
        <lineSegments geometry={brushGeometry}>
          <lineBasicMaterial
            color="#ffffff"
            transparent
            opacity={painting ? 1 : 0.55}
            toneMapped={false}
          />
        </lineSegments>
      )}
    </>
  );
}

function lineGeometry(positions: Float32Array): BufferGeometry {
  const geometry = new BufferGeometry();
  // `subarray` views share the parent buffer; copy so the attribute owns its
  // memory and three can upload it without surprises.
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  return geometry;
}

/** Dispose a memoised geometry when it is replaced or the component unmounts. */
function useDisposeOnChange(geometry: BufferGeometry | null): void {
  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);
}

function useDisposeAllOnChange(items: Array<{ geometry: BufferGeometry }>): void {
  useEffect(() => {
    return () => {
      for (const item of items) item.geometry.dispose();
    };
  }, [items]);
}

/* ========================================================================== */
/*  Free-fly                                                                  */
/* ========================================================================== */

const FLY_SPEED = TILE_SIZE * 8; // world units per second
const FLY_SPRINT = 4;

/**
 * Free-fly shares the orbit state's yaw and pitch rather than keeping its own.
 *
 * In orbit the camera sits at `target + offset(yaw, pitch)` looking back at the
 * target, so its view direction is exactly `-offset`. Driving fly mode from the
 * same two angles means switching modes never changes where you are looking,
 * and one right-drag handler serves both.
 */
export function flyForward(yawDeg: number, pitchDeg: number): Vector3 {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  return new Vector3(
    -Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch)
  );
}

function applyFly(
  camera: PerspectiveCamera,
  held: Set<string>,
  delta: number,
  orbitRef: React.MutableRefObject<OrbitState>
): void {
  const speed = FLY_SPEED * delta * (held.has('shift') ? FLY_SPRINT : 1);
  const forward = flyForward(orbitRef.current.yaw, orbitRef.current.pitch);
  const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();

  const move = new Vector3();
  if (held.has('w')) move.addScaledVector(forward, 1);
  if (held.has('s')) move.addScaledVector(forward, -1);
  if (held.has('d')) move.addScaledVector(right, 1);
  if (held.has('a')) move.addScaledVector(right, -1);
  if (held.has('e')) move.y += 1;
  if (held.has('q')) move.y -= 1;

  if (move.lengthSq() > 0) {
    move.normalize().multiplyScalar(speed);
    camera.position.add(move);
  }

  camera.lookAt(
    camera.position.x + forward.x,
    camera.position.y + forward.y,
    camera.position.z + forward.z
  );

  // Keep the orbit target ahead of the camera, so switching back to orbit
  // pivots around what you were looking at instead of teleporting.
  const ahead = camera.position.clone().addScaledVector(forward, orbitRef.current.distance);
  orbitRef.current = { ...orbitRef.current, target: [ahead.x, ahead.y, ahead.z] };
}

/* ========================================================================== */
/*  The host component                                                        */
/* ========================================================================== */

export function Viewport3D(props: ViewportProps) {
  const { plane, sectors, activeSector, config, painting, regionDrag, onPick, onHover, onDragRegion } =
    props;

  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<SceneApi | null>(null);
  const dragRef = useRef<{
    mode: 'paint' | 'pan' | 'region' | 'orbit';
    from: WorldTile | null;
  } | null>(null);
  const lastHover = useRef<WorldTile | null>(null);

  const [atlas, setAtlas] = useState<ResolvedAtlas | null>(null);
  const [atlasError, setAtlasError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [plates, setPlates] = useState<Plate[]>([]);
  const [mode, setMode] = useState<CameraMode>('orbit');
  const [hud, setHud] = useState({ triangles: 0, sectors: 0, pending: 0, fps: 0 });

  const modeRef = useRef<CameraMode>('orbit');
  const flyRef = useRef<Set<string>>(new Set());
  const orbitRef = useRef<OrbitState>(
    overviewOrbit(sectorCentre(activeSector?.x ?? 50, activeSector?.y ?? 50))
  );

  const cache = useMemo(() => new SectorGeometryCache(), []);
  useEffect(() => () => cache.clear(), [cache]);

  /**
   * The atlas -- the project's own sheet when the server has one, else bundled.
   *
   * Keyed on `config` rather than mounting once, because the scene mounts
   * before the API has opened a project and the sheet lives under the project.
   * `config` arriving is the signal that a project exists; `loadAtlas()`
   * deliberately does not memoise a too-early miss, so this second call is the
   * one that gets the real sheet. Resolving to the same result is a no-op.
   */
  useEffect(() => {
    let alive = true;
    loadAtlas().then(
      (resolved) => {
        if (!alive) return;
        setAtlas((current) => (current?.source === 'server' ? current : resolved));
      },
      (err: unknown) => alive && setAtlasError(err instanceof Error ? err.message : String(err))
    );
    return () => {
      alive = false;
    };
  }, [config]);

  /* sectors -> mesh queue */
  const sectorList = useMemo(() => {
    const map = new Map<string, SectorSource>();
    for (const [key, sector] of Object.entries(sectors)) {
      if (sector.coord.plane !== plane) continue;
      map.set(key, sector);
    }
    return map;
  }, [sectors, plane]);

  // Wait for the atlas to settle before the first mesh. A layout change
  // invalidates every geometry (the uvs move), so meshing first and texturing
  // second would mesh the whole neighbourhood twice.
  const atlasSettled = atlas !== null || atlasError !== null;

  useEffect(() => {
    if (!atlasSettled) return;
    if (cache.request(sectorList, config ?? null, atlas ? atlas.layout : null)) {
      setVersion((v) => v + 1);
    }
  }, [cache, sectorList, config, atlas, atlasSettled]);

  /* recentre on the active sector */
  useEffect(() => {
    if (!activeSector) return;
    orbitRef.current = {
      ...orbitRef.current,
      target: sectorCentre(activeSector.x, activeSector.y)
    };
  }, [activeSector?.x, activeSector?.y, activeSector?.plane]);

  /* fly keys */
  useEffect(() => {
    if (mode !== 'fly') {
      flyRef.current.clear();
      return;
    }
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (FLY_KEYS.has(key)) {
        flyRef.current.add(key);
        e.preventDefault();
      }
      if (e.shiftKey) flyRef.current.add('shift');
    };
    const up = (e: KeyboardEvent) => {
      flyRef.current.delete(e.key.toLowerCase());
      if (!e.shiftKey) flyRef.current.delete('shift');
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      flyRef.current.clear();
    };
  }, [mode]);

  /* HUD, sampled rather than rendered per frame */
  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - last >= 500) {
        const stats = cache.stats();
        setHud({
          triangles: stats.triangles,
          sectors: stats.cached,
          pending: stats.pending,
          fps: Math.round((frames * 1000) / (now - last))
        });
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cache]);

  /* ------------------------------------------------------------- pointer -- */

  const ndc = useCallback((e: React.PointerEvent | React.WheelEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((e.clientY - rect.top) / rect.height) * 2 - 1)
    };
  }, []);

  const pickAt = useCallback(
    (e: React.PointerEvent): WorldTile | null => {
      const api = apiRef.current;
      if (!api) return null;
      const p = ndc(e);
      return api.pick(p.x, p.y).tile;
    },
    [ndc]
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const tile = pickAt(e);

    // Right-drag orbits. Middle-drag and shift+left pan, exactly as the 2D
    // viewport did, so the documented shortcuts still hold.
    if (e.button === 2) {
      dragRef.current = { mode: 'orbit', from: tile };
      return;
    }
    if (e.button === 1 || (e.button === 0 && e.shiftKey && !regionDrag)) {
      dragRef.current = { mode: 'pan', from: tile };
      return;
    }
    if (e.button !== 0 || !tile) return;

    if (regionDrag) {
      dragRef.current = { mode: 'region', from: tile };
      onDragRegion({ plane, x0: tile.wx, y0: tile.wy, x1: tile.wx, y1: tile.wy });
      return;
    }
    dragRef.current = { mode: 'paint', from: tile };
    onPick(tile, { alt: e.altKey, shift: e.shiftKey });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;

    if (drag?.mode === 'orbit') {
      const next = {
        ...orbitRef.current,
        yaw: orbitRef.current.yaw - e.movementX * 0.3,
        pitch: orbitRef.current.pitch + e.movementY * 0.3
      };
      orbitRef.current = modeRef.current === 'fly' ? clampFly(next) : clampOrbit(next);
      return;
    }

    if (drag?.mode === 'pan') {
      panBy(orbitRef, e.movementX, e.movementY);
      return;
    }

    const tile = pickAt(e);
    if (!sameTile(tile, lastHover.current)) {
      lastHover.current = tile;
      onHover(tile);
    }
    if (!drag || !tile) return;

    if (drag.mode === 'region' && drag.from) {
      onDragRegion({ plane, x0: drag.from.wx, y0: drag.from.wy, x1: tile.wx, y1: tile.wy });
    } else if (drag.mode === 'paint') {
      onPick(tile, { alt: e.altKey, shift: e.shiftKey });
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (modeRef.current === 'fly') return;
    orbitRef.current = clampOrbit({
      ...orbitRef.current,
      distance: orbitRef.current.distance * (e.deltaY < 0 ? 1 / 1.15 : 1.15)
    });
  };

  const setCameraMode = (next: CameraMode) => {
    modeRef.current = next;
    // Fly allows looking up; orbit does not (it would put the camera below the
    // ground). Re-clamp on the way back so the first orbit frame is valid.
    if (next === 'orbit') orbitRef.current = clampOrbit(orbitRef.current);
    setMode(next);
  };

  const goInGame = () => {
    orbitRef.current = clampOrbit(
      inGameOrbit(orbitRef.current.target, orbitRef.current.yaw)
    );
    setCameraMode('orbit');
  };

  const goOverview = () => {
    orbitRef.current = clampOrbit(overviewOrbit(orbitRef.current.target));
    setCameraMode('orbit');
  };

  const ready = !!config;

  return (
    <div className="viewport" ref={hostRef}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          cursor: painting ? 'crosshair' : 'default',
          touchAction: 'none'
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerLeave={() => {
          dragRef.current = null;
          lastHover.current = null;
          onHover(null);
        }}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Canvas
          flat
          linear
          // `pointer-events` is inherited, so this reaches the canvas element
          // and stops react-three-fiber's own event system ever firing. All
          // pointer handling is on the wrapper above, and r3f's would otherwise
          // raycast the entire scene a second time on every mouse move.
          style={{ pointerEvents: 'none' }}
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
          // near is a quarter of a tile, not centimetres: RSC lays genuinely
          // coincident quads (a bridge deck over the tile beneath it), and a
          // tiny near plane spends all the depth buffer's precision up close
          // and makes those z-fight at distance.
          camera={{ fov: 55, near: TILE_SIZE / 4, far: MAX_DISTANCE * 2 }}
          onCreated={({ gl }) => {
            // No output conversion and no tone mapping: see the header.
            gl.outputColorSpace = LinearSRGBColorSpace;
            gl.toneMapping = NoToneMapping;
            gl.setClearColor(0x0d0f12, 1);
          }}
        >
          <SceneContents
            {...props}
            sectorList={sectorList}
            cache={cache}
            atlas={atlas?.texture ?? null}
            orbitRef={orbitRef}
            modeRef={modeRef}
            flyRef={flyRef}
            apiRef={apiRef}
            version={version}
            onBuilt={() => setVersion((v) => v + 1)}
            onPlates={setPlates}
          />
        </Canvas>
      </div>

      <div className="viewport__overlay">
        {plates.map((p) => (
          <span
            key={p.key}
            className="viewport__nameplate"
            style={{ left: p.x, top: p.y, background: p.colour }}
          >
            {p.name}
          </span>
        ))}

        <div className="viewport__badge">
          <span>
            3D viewport &middot; {hud.sectors} sector{hud.sectors === 1 ? '' : 's'} &middot;{' '}
            {hud.triangles.toLocaleString()} tris &middot; {hud.fps} fps
          </span>
          <span style={{ color: 'var(--fg-2)' }}>
            {!ready
              ? 'waiting for cache definitions…'
              : hud.pending > 0
                ? `meshing ${hud.pending} more sector${hud.pending === 1 ? '' : 's'}…`
                : atlasError
                  ? `textures unavailable: ${atlasError}`
                  : atlas
                    ? `geometry and shading from packages/render — unlit, as the client draws it · ${
                        atlas.source === 'server'
                          ? "this project's atlas"
                          : 'bundled atlas'
                      }`
                    : 'loading textures…'}
          </span>
          <span style={{ color: 'var(--fg-2)' }}>
            right-drag orbit &middot; middle/shift-drag pan &middot; wheel zoom
            {mode === 'fly' ? ' · WASD/QE fly, shift to sprint' : ''}
          </span>
        </div>

        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            display: 'flex',
            gap: 4,
            pointerEvents: 'auto'
          }}
        >
          <CameraButton active={mode === 'orbit'} onClick={() => setCameraMode('orbit')}>
            orbit
          </CameraButton>
          <CameraButton active={mode === 'fly'} onClick={() => setCameraMode('fly')}>
            fly
          </CameraButton>
          <CameraButton active={false} onClick={goInGame} title="RSC's own pitch and zoom">
            in-game
          </CameraButton>
          <CameraButton active={false} onClick={goOverview} title="Frame the whole sector">
            sector
          </CameraButton>
        </div>
      </div>
    </div>
  );
}

const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);

/** Pan the orbit target across the ground plane, in screen-relative directions. */
function panBy(
  orbitRef: React.MutableRefObject<OrbitState>,
  dx: number,
  dy: number
): void {
  const state = orbitRef.current;
  // Pixels -> world units, scaled by how far away we are so the ground tracks
  // the cursor at any zoom.
  const scale = state.distance / 600;
  const yaw = (state.yaw * Math.PI) / 180;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);

  const forwardX = -sin;
  const forwardZ = -cos;
  const rightX = cos;
  const rightZ = -sin;

  orbitRef.current = {
    ...state,
    target: [
      state.target[0] - (rightX * dx + forwardX * dy) * scale,
      state.target[1],
      state.target[2] - (rightZ * dx + forwardZ * dy) * scale
    ]
  };
}

function CameraButton({
  active,
  onClick,
  title,
  children
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        padding: '3px 8px',
        fontFamily: 'var(--mono)',
        fontSize: 10.5,
        color: active ? '#0d0f12' : 'var(--fg-1)',
        background: active ? '#4c9aff' : 'rgba(13, 15, 18, 0.78)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        cursor: 'pointer'
      }}
    >
      {children}
    </button>
  );
}
