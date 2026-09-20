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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ColorManagement,
  DoubleSide,
  FrontSide,
  InstancedMesh,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  Raycaster,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Texture
} from 'three';
import { SECTOR_WIDTH, sectorKey } from '@rsc-editor/schema';
import {
  TILE_SIZE,
  connectorLinkLines,
  connectorMarkerLines,
  planesFor,
  planeStorey,
  type ConnectorPlacement,
  type PlaneSetMode
} from '@rsc-editor/render';
import type { WorldTile } from '../ops/coords.js';
import { ATLAS_ALPHA_TEST, loadAtlas, type ResolvedAtlas } from './atlas-texture.js';
import {
  clampFly,
  clampOrbit,
  inGameOrbit,
  MAP_NORTH_YAW,
  MAX_DISTANCE,
  orbitPose,
  overviewOrbit,
  sectorCentre,
  type CameraMode,
  type OrbitState
} from './camera.js';
import { PlaneSectorCache, planeSectorCoords } from './plane-sectors.js';
import {
  buildBrushOutline,
  buildEntityMarkers,
  buildRectOutline,
  buildSectorBorder,
  buildTileGrid,
  clampWindow,
  sectorTintTransform
} from './overlay-geometry.js';
import { createMesher } from './mesher.js';
import { sameTile, tilesBetween, tileOfFace, tileOfGroundPlane, worldTileAt } from './picking.js';
import {
  SectorGeometryCache,
  SECTOR_SPAN,
  WorldHeights,
  type SceneryDraw,
  type SectorGeometrySet,
  type SectorSource
} from './sector-geometry.js';
import { loadSceneryModels, type ResolvedModels } from './scenery-models.js';
import { refreshLibraryAssets } from './library-refresh.js';
import { EntitySprites } from './EntitySprites.js';
import type { ViewportProps } from './viewport-props.js';
import { inTextField } from '../hooks/useKeyboard.js';

// The vertex colours are final sRGB values, not linear working-space colours.
// See the header.
ColorManagement.enabled = false;

/** Tiles of grid drawn around the camera target. A grid is a precision aid. */
const GRID_WINDOW = 64;

/** Sectors meshed per frame. Meshing a dense sector costs ~100ms. */
const MESH_BUDGET = 1;

/**
 * ============================================================================
 *  HOW AN INACTIVE PLANE IS DRAWN, AND WHY IT IS DRAWN THAT WAY
 * ============================================================================
 *
 * Ghosted: the same geometry, the same RSC lighting, `transparent` at
 * {@link GHOST_OPACITY} with `depthWrite: false`. Not an outline, and not
 * hidden.
 *
 * The alternatives and why they lose:
 *
 *   - **Opaque.** A ground floor under a first floor is simply invisible, and a
 *     first floor under the ground floor's roof is too. That is the bug being
 *     fixed; stacking opaque floors is worse than showing one at a time because
 *     it looks like there is nothing up there.
 *   - **Outlines only.** Readable, but it throws away the one thing that says
 *     *what* a floor is -- its overlay colours and textures. "Is the room above
 *     this one a kitchen or a staircase landing" is a colour question, and an
 *     editor that answers it with a wireframe is answering a different one.
 *   - **Ghosted with `depthWrite: true`.** A translucent surface that still
 *     writes depth occludes whatever is drawn after it, so the active plane
 *     would flicker in and out depending on draw order. `depthWrite: false` is
 *     what makes a ghost never hide anything: it is depth-*tested*, so a ghost
 *     behind a solid wall stays behind it, but it never becomes the reason
 *     something else is missing.
 *
 * The active plane keeps `FrontSide`, full opacity and depth writes -- it is
 * exactly what the viewport drew before -- and it is the only thing the picker
 * raycasts, so a click always lands on the plane you are editing even when the
 * pointer is over a ghost.
 *
 * ### On the value
 *
 * It was 0.34, and at that value a storey is present in the scene and
 * effectively invisible. An upper floor is not a slab of surface like the
 * active plane -- with its deck suppressed it is a thin ring of wall a few
 * hundred triangles wide -- so a third of the colour of a dark stone wall,
 * blended over water or over the floor below, reads as nothing at all. Painting
 * those same meshes opaque in the live scene showed them exactly where they
 * belonged, stacked on the tower: the bug was legibility, not geometry.
 *
 * 0.72 keeps "you can see through it" while leaving a storey legible from a
 * distance. It is a number to look at rather than reason about, so it is here
 * on its own.
 */
const GHOST_OPACITY = 0.72;

/** Server-side placement markers: NPC pins, item squares, door frames. */
const ENTITY_COLOURS = { npc: '#ffd84a', item: '#4de1ff', door: '#ff8a3d' } as const;

/** How far the pointer must travel after a press before painting follows it. */
const PAINT_DRAG_THRESHOLD_PX = 5;

/** Wireframe colour for walls the client skips; magenta reads against grass, stone and water. */
const HIDDEN_WALL_COLOUR = '#ff3df2';

/** Colours for the connector overlay. Amber links, green markers. */
const LINK_COLOUR = '#ffb020';
const MARKER_COLOUR = '#5cf08a';

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
  /** planes being drawn, bottom to top */
  planeSet: number[];
  showConnectors: boolean;
  showHiddenWalls: boolean;
  showEntitySprites: boolean;
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

  /**
   * Where each plane's geometry is drawn.
   *
   * Exactly zero when only one plane is on screen, whichever plane that is:
   * there is nothing to stack it against, and lifting a lone first floor 192
   * units off the orbit target would move the camera's idea of the world for no
   * benefit. Single-plane mode is therefore byte-for-byte the view the viewport
   * has always drawn.
   */
  const stacking = props.planeSet.length > 1;
  /**
   * ONE height per plane, solved at the sector you are looking at.
   *
   * Both halves of that matter, and each was a bug:
   *
   *   - Solving it over the whole loaded neighbourhood averages ladders
   *     standing on unrelated terrain. At Wizards' Tower that put floor 1 at
   *     438 where the tower's own ladders say 534 -- 96 units low, inside the
   *     storey beneath -- and the number moved as you panned.
   *   - Solving it per sector instead scatters one plane across as many heights
   *     as there are sectors (391, 438, 534, 576 ... measured in the live
   *     scene), which tears a building apart at its sector seams and leaves a
   *     few hundred triangles at each height. Coherently wrong beats
   *     incoherently right.
   *
   * So: the active sector decides, and every sector of that plane uses its
   * answer. The building you are working on is placed correctly and the rest of
   * the world stays consistent with it.
   */
  const planeY = useCallback(
    (plane: number) =>
      stacking
        ? props.activeSector
          ? cache.storeyOffset(props.activeSector, plane)
          : cache.planeOffset(plane)
        : 0,
    // `version` is what changes when a sector finishes meshing and the offsets
    // are re-solved; the cache object itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cache, stacking, props.version, props.activeSector?.x, props.activeSector?.y]
  );
  const activePlaneY = planeY(props.plane);

  /**
   * Where a plane's per-corner walls and roofs are drawn, as opposed to its
   * deck.
   *
   * Those are meshed at their absolute storey heights (`absoluteWalls`), so
   * stacked they need no lift at all. Drawn alone, the deck sits at 0 rather
   * than at its stacked height, and the walls move down by the same amount so
   * they stay where they were relative to it. Either way this is
   * `planeY - stackedY`.
   */
  const absoluteWallY = useCallback(
    (plane: number) => {
      const stackedY = props.activeSector
        ? cache.storeyOffset(props.activeSector, plane)
        : cache.planeOffset(plane);
      return planeY(plane) - stackedY;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cache, planeY, props.version, props.activeSector?.x, props.activeSector?.y]
  );

  const pick = useCallback(
    (ndcX: number, ndcY: number): PickResult => {
      raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);
      // Only the ACTIVE plane's terrain is in this list. A ghost storey is there
      // to be looked through, not clicked through: if it could take a hit, a
      // brush stroke on the ground floor would silently start landing on the
      // first floor wherever one happens to be overhead.
      const meshes = [...terrainMeshes.current.values()];
      // A sector re-meshed by an edit mounts a new mesh whose world matrix is
      // still identity until the next frame renders, so a pick in between
      // missed it and fell through to the flat ground plane -- a tile far from
      // the cursor on a hill. Painting re-meshes on every tile, so a held
      // stroke jumped around and left gaps.
      for (const mesh of meshes) mesh.updateWorldMatrix(true, false);
      const hits = raycaster.intersectObjects(meshes, false);
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
      const tile = tileOfGroundPlane(
        props.plane,
        raycaster.ray.origin,
        raycaster.ray.direction,
        activePlaneY
      );
      return { tile, point: null };
    },
    [camera, raycaster, props.plane, activePlaneY]
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
      // Locks are per sector per plane, but a nameplate is a label on a place:
      // one per sector, on the plane being edited, or a stacked view would show
      // four copies of the same name.
      if (entry.coord.plane !== props.plane) continue;
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

  const drawn = new Set(props.planeSet);

  return (
    <>
      {cache.list().map((set) => {
        if (!drawn.has(set.coord.plane)) return null;
        const ghost = set.coord.plane !== props.plane;
        // Keyed on the signature as well as the sector, so a re-meshed sector's
        // new mesh can never be evicted by its predecessor's unmount -- and on
        // `ghost`, because switching the active plane has to remount the layer:
        // `register` is a ref callback and `raycast` a constructor-time prop,
        // and neither re-runs on a prop change alone.
        // A storey ABOVE the one being edited draws no deck. See `showDeck`.
        const above = planeStorey(set.coord.plane) > planeStorey(props.plane);
        const id = `${set.key}:${set.signature}:${ghost ? 'g' : 's'}${above ? 'n' : 'd'}`;
        return (
          <SectorLayer
            key={id}
            set={set}
            atlas={atlas}
            ghost={ghost}
            showDeck={!above}
            showHiddenWalls={props.showHiddenWalls && !ghost}
            planeY={planeY(set.coord.plane)}
            wallY={set.absoluteWalls ? absoluteWallY(set.coord.plane) : planeY(set.coord.plane)}
            register={
              ghost
                ? undefined
                : (mesh) => {
                    if (mesh) terrainMeshes.current.set(id, mesh);
                    else terrainMeshes.current.delete(id);
                  }
            }
          />
        );
      })}

      <SceneryLayer
        draws={cache.sceneryDraws().filter((draw) => drawn.has(draw.plane))}
        atlas={atlas}
        activePlane={props.plane}
        planeY={planeY}
      />

      {props.showConnectors && (
        <ConnectorLayer cache={cache} planeSet={props.planeSet} planeY={planeY} />
      )}

      <group position={[0, activePlaneY, 0]}>
        <Overlays {...props} />
      </group>
    </>
  );
}

/* ========================================================================== */
/*  Floor connectors                                                          */
/* ========================================================================== */

/**
 * Ladders, staircases and trapdoors, and the links between the storeys they
 * join.
 *
 * `depthTest: false` on purpose, and it is the point rather than a shortcut. A
 * ladder is inside a building, under a roof, behind a wall; a link drawn with
 * depth testing is a link you can never see, which makes the whole overlay
 * decorative. This is editor furniture, not client geometry -- nothing about
 * what RSC draws depends on it -- so it is allowed to be the one thing that
 * always reads.
 *
 * Which objects count comes from `connectorOf()` in `@rsc-editor/render`, which
 * resolves the `commands` list from the definition table. `climb over` (40
 * objects in the shipped cache, all fences and rocks) is deliberately not a
 * connector; see that file's header.
 */
function ConnectorLayer({
  cache,
  planeSet,
  planeY
}: {
  cache: SectorGeometryCache;
  planeSet: number[];
  /** the SAME function the geometry layers use, so a marker sits on its floor */
  planeY: (plane: number) => number;
}) {
  const graph = cache.connectorGraph();
  const key = planeSet.join(',');

  const geometries = useMemo(() => {
    const drawn = new Set(planeSet);
    // Filtered to the planes on screen: a link with one end on a plane that is
    // not being drawn would be a line running off into nothing, and a marker
    // for an invisible floor is a claim about geometry nobody can check.
    //
    // `y` is recomputed through `planeY` rather than taken from the graph,
    // because single-plane mode draws at offset 0 and a marker floating 192
    // units above its own ladder would be worse than no marker.
    const place = (c: ConnectorPlacement): ConnectorPlacement => ({
      ...c,
      y: c.groundY + planeY(c.plane)
    });

    const visible = graph.placements.filter((c) => drawn.has(c.plane)).map(place);
    const links = graph.links
      .filter((link) => drawn.has(link.lower.plane) && drawn.has(link.upper.plane))
      .map((link) => ({ lower: place(link.lower), upper: place(link.upper) }));

    return {
      links: lineGeometry(connectorLinkLines(links)),
      markers: lineGeometry(connectorMarkerLines(visible)),
      count: visible.length,
      linked: links.length
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, key, planeY]);

  useDisposeOnChange(geometries.links);
  useDisposeOnChange(geometries.markers);

  if (geometries.count === 0) return null;

  return (
    <>
      {/*
        `depthWrite: false` alongside `depthTest: false`: an overlay that always
        draws must not also leave depth values behind for the ghost planes to
        sort against afterwards.
      */}
      <lineSegments geometry={geometries.markers} renderOrder={998}>
        <lineBasicMaterial
          color={MARKER_COLOUR}
          depthTest={false}
          depthWrite={false}
          transparent
          opacity={0.85}
          toneMapped={false}
        />
      </lineSegments>
      <lineSegments geometry={geometries.links} renderOrder={999}>
        <lineBasicMaterial
          color={LINK_COLOUR}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>
    </>
  );
}

/* ========================================================================== */
/*  Scenery                                                                   */
/* ========================================================================== */

/**
 * Every `.ob3` model in the loaded neighbourhood, one instanced draw per
 * (model, direction).
 *
 * Not inside `SectorLayer`: scenery batches span sectors on purpose. A world is
 * a handful of tree models and thousands of trees, so the draw call has to be
 * per model, and per model per sector would be twenty-five times as many for no
 * benefit. See the header of `sector-geometry.ts`.
 *
 * Same material as the terrain layers, for the same reasons -- unlit, vertex
 * colours from RSC's own lighting, `alphaTest` for the pure-green cutouts that
 * doorways and flames depend on.
 */
function SceneryLayer({
  draws,
  atlas,
  activePlane,
  planeY
}: {
  draws: SceneryDraw[];
  atlas: Texture | null;
  activePlane: number;
  planeY: (plane: number) => number;
}) {
  // Two materials for every scenery batch rather than one per batch. Identical
  // settings, so three compiles the same program either way, but a hundred
  // material objects rebuilt whenever a sector finishes meshing is churn for
  // nothing. Owned here, so disposed here -- r3f only disposes what it created.
  const materials = useMemo(() => {
    const base = {
      vertexColors: true,
      map: atlas,
      side: FrontSide,
      // `alphaTest` WITHOUT `transparent`, exactly as the sector layers: a
      // pure-green palette entry is a CUTOUT (DECISIONS section 8), a hole
      // rather than a translucent surface, and doorways and flames need it.
      alphaTest: ATLAS_ALPHA_TEST,
      toneMapped: false
    };
    return {
      solid: new MeshBasicMaterial(base),
      // See GHOST_OPACITY: transparent and NOT depth-writing, so a tree on an
      // upper storey never becomes the reason something below it is missing.
      ghost: new MeshBasicMaterial({
        ...base,
        transparent: true,
        opacity: GHOST_OPACITY,
        depthWrite: false
      })
    };
  }, [atlas]);

  useEffect(
    () => () => {
      materials.solid.dispose();
      materials.ghost.dispose();
    },
    [materials]
  );

  return (
    <>
      {draws.map((draw) => (
        <SceneryBatchMesh
          key={draw.key}
          draw={draw}
          material={draw.plane === activePlane ? materials.solid : materials.ghost}
          planeY={planeY(draw.plane)}
        />
      ))}
    </>
  );
}

function SceneryBatchMesh({
  draw,
  material,
  planeY
}: {
  draw: SceneryDraw;
  material: MeshBasicMaterial;
  planeY: number;
}) {
  const ref = useRef<InstancedMesh>(null);

  // Layout, not passive: r3f mounts the mesh with an all-zero instance matrix,
  // and an effect that lands after paint would show one frame of every model
  // collapsed at the world origin.
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    (mesh.instanceMatrix.array as Float32Array).set(draw.matrices);
    mesh.instanceMatrix.needsUpdate = true;
    // Over the instances, so a batch spread across the neighbourhood is not
    // frustum-culled by the bounds of a single copy at the world origin.
    mesh.computeBoundingSphere();
  }, [draw]);

  return (
    <instancedMesh
      ref={ref}
      // The plane's vertical offset is a transform on the MESH, not on the
      // instance matrices: the offsets are re-solved whenever another plane's
      // sector arrives, and rebuilding thousands of matrices for a number that
      // moves would be the one expensive thing in the frame.
      position={[0, planeY, 0]}
      // `args` is the constructor call, so a changed count or geometry
      // reconstructs the mesh -- which is what has to happen when a sector
      // finishes meshing and adds copies to a batch.
      args={[draw.geometry, material, draw.count]}
      // Scenery is not pickable yet, and raycasting thousands of instances on
      // every pointer move is not free. The terrain is what the editor picks.
      raycast={() => null}
    />
  );
}

/* ========================================================================== */
/*  One sector's three layers                                                 */
/* ========================================================================== */

function SectorLayer({
  set,
  atlas,
  ghost,
  showDeck,
  planeY,
  wallY,
  register,
  showHiddenWalls
}: {
  /** overlay the walls the client skips as a wireframe */
  showHiddenWalls: boolean;
  set: SectorGeometrySet;
  atlas: Texture | null;
  /** true for a plane that is being shown but not edited; see GHOST_OPACITY */
  ghost: boolean;
  /**
   * Draw this plane's terrain.
   *
   * False for every storey ABOVE the one being edited, which is what the client
   * does: `World#_loadSection_from4` forces plane 1 and 2 terrain to
   * `World.colourTransparent`, so an upper floor contributes its walls, roof and
   * scenery but no visible deck.
   *
   * It is also the difference between a stacked view that works and one that
   * does not. A deck is a solid horizontal slab across the whole building; even
   * at GHOST_OPACITY, two or three of them stacked over the floor you are
   * editing wash it out completely, and from a top-down camera all you see is
   * the topmost floorboards. That is what "I can only see 1 floor" turns out to
   * mean -- the floors were all there, one was simply laid over the others.
   *
   * The active plane always draws its own deck: it is the thing being edited,
   * and it is the pick target.
   */
  showDeck: boolean;
  /** render-space Y this plane's deck is drawn at */
  planeY: number;
  /**
   * render-space Y for the walls and roofs. Differs from `planeY` when they
   * were meshed at absolute per-corner heights; see `absoluteWalls`.
   */
  wallY: number;
  /** omitted for a ghost plane, which is not pickable */
  register?: (mesh: Mesh | null) => void;
}) {
  // The ACTIVE plane: `alphaTest` WITHOUT `transparent`. A cutout is a hole, not
  // a translucent surface: leaving the material opaque keeps it in the
  // depth-sorted opaque queue and discards the cut texels in the shader, which
  // is exactly what the client's `clearRect` cutouts do. Turning `transparent`
  // on as well would move every sector into the back-to-front transparent pass
  // and make walls sort against each other for no reason.
  //
  // A GHOST plane is transparent on purpose and pays that cost knowingly -- it
  // is the only way to see through a floor -- but keeps `depthWrite: false` so
  // it can never hide the plane being edited. See GHOST_OPACITY.
  const material = (
    <meshBasicMaterial
      vertexColors
      map={atlas}
      side={FrontSide}
      alphaTest={ATLAS_ALPHA_TEST}
      toneMapped={false}
      transparent={ghost}
      opacity={ghost ? GHOST_OPACITY : 1}
      depthWrite={!ghost}
    />
  );

  return (
    <group position={[set.originX, 0, set.originZ]}>
      <group position={[0, planeY, 0]}>
        {showDeck && set.terrain && (
          <mesh
            ref={(mesh) => {
              // The picker reads `userData.sector` to turn a faceIndex into a
              // tile; see picking.ts.
              if (mesh) mesh.userData.sector = set;
              register?.(mesh);
            }}
            geometry={set.terrain}
            // A ghost storey is there to be looked through. Raycasting it would
            // let a click land on a floor the user is not editing.
            raycast={ghost ? () => null : undefined}
          >
            {material}
          </mesh>
        )}
      </group>
      <group position={[0, wallY, 0]}>
        {set.walls && <mesh geometry={set.walls}>{material}</mesh>}
        {set.roofs && <mesh geometry={set.roofs}>{material}</mesh>}
        {showHiddenWalls && set.hiddenWalls && (
          // Not pickable and never hides anything: it is a marker, not a surface.
          <mesh geometry={set.hiddenWalls} raycast={() => null} renderOrder={1}>
            <meshBasicMaterial color={HIDDEN_WALL_COLOUR} wireframe toneMapped={false} side={DoubleSide} />
          </mesh>
        )}
      </group>
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
    version,
    entities,
    config,
    showEntitySprites
  } = props;
  const libraryVersion = props.libraryVersion ?? 0;
  // Entities drawn as pictures; the rest keep their line markers.
  const [pictured, setPictured] = useState<ReadonlySet<string>>(() => new Set());
  const onPictured = useCallback((ids: ReadonlySet<string>) => setPictured(ids), []);
  const onPlaneEntities = useMemo(
    () => (entities ?? []).filter((e) => e.plane === plane),
    [entities, plane]
  );

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

  const ghost = props.ghost ?? null;
  const brushGeometry = useMemo(() => {
    if (!hoverTile || hoverTile.plane !== plane) return null;
    if (ghost) {
      // The Group tool's drop preview: where the group will land.
      const r = ghost(hoverTile);
      return lineGeometry(buildRectOutline(heights, r.x0, r.y0, r.x1, r.y1));
    }
    return lineGeometry(
      buildBrushOutline(heights, hoverTile.wx, hoverTile.wy, brushRadius, brushShape)
    );
  }, [hoverTile, plane, brushRadius, brushShape, heights, ghost]);

  // Server-side placements: one line buffer per kind, plus the selection on
  // top of them. Only the plane being edited, like the other overlays.
  const entityGeometries = useMemo(() => {
    const onPlane = onPlaneEntities;
    const drawnAsPicture = (id: string) => showEntitySprites && pictured.has(id);
    const byKind = (kind: 'npc' | 'item' | 'door') =>
      lineGeometry(
        buildEntityMarkers(
          heights,
          onPlane.filter((e) => e.kind === kind && !e.selected && !drawnAsPicture(e.id))
        )
      );
    const selected = onPlane.filter((e) => e.selected);
    const wander = selected.find((e) => e.wander)?.wander;
    return {
      npc: byKind('npc'),
      item: byKind('item'),
      door: byKind('door'),
      selected: lineGeometry(buildEntityMarkers(heights, selected)),
      wander: wander
        ? lineGeometry(buildRectOutline(heights, wander.x0, wander.y0, wander.x1, wander.y1))
        : null
    };
  }, [onPlaneEntities, heights, pictured, showEntitySprites]);
  useEffect(() => {
    return () => {
      for (const g of Object.values(entityGeometries)) g?.dispose();
    };
  }, [entityGeometries]);

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

      {showEntitySprites && (
        <EntitySprites
          entities={onPlaneEntities}
          config={config}
          heights={heights}
          libraryVersion={libraryVersion}
          onPictured={onPictured}
        />
      )}
      {(['npc', 'item', 'door'] as const).map((kind) => (
        <lineSegments key={`entities-${kind}`} geometry={entityGeometries[kind]}>
          <lineBasicMaterial color={ENTITY_COLOURS[kind]} toneMapped={false} />
        </lineSegments>
      ))}
      <lineSegments geometry={entityGeometries.selected}>
        <lineBasicMaterial color="#ffffff" toneMapped={false} depthTest={false} />
      </lineSegments>
      {entityGeometries.wander && (
        <lineSegments geometry={entityGeometries.wander}>
          <lineBasicMaterial color={ENTITY_COLOURS.npc} toneMapped={false} />
        </lineSegments>
      )}

      {brushGeometry && (
        <lineSegments geometry={brushGeometry}>
          <lineBasicMaterial
            color={ghost ? '#ffb020' : '#ffffff'}
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
    /** paint: the tile the last edit went to, so a drag edits each tile once */
    last?: WorldTile | null;
    /** paint: where the button went down, in screen pixels */
    downX?: number;
    downY?: number;
    /** paint: the pointer has travelled far enough to count as a drag */
    moved?: boolean;
  } | null>(null);
  const lastHover = useRef<WorldTile | null>(null);

  const [atlas, setAtlas] = useState<ResolvedAtlas | null>(null);
  const [atlasError, setAtlasError] = useState<string | null>(null);
  /** `undefined` = still asking, `null` = definitively none. */
  const [models, setModels] = useState<ResolvedModels | null | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [plates, setPlates] = useState<Plate[]>([]);
  const [mode, setMode] = useState<CameraMode>('orbit');
  /**
   * `all` is the default, deliberately.
   *
   * It was `single` on the grounds that stacking is a question you ask
   * occasionally ("where does this ladder go?") and then turn off. That had it
   * backwards: mudclient itself draws planes 0, 1 and 2 together whenever you
   * are standing on the ground (`World#_loadSection_from3`), so a stacked view
   * is the *faithful* one and a lone ground floor is the special case. See
   * `packages/render/src/planes.ts` and DECISIONS 14.
   *
   * `this one` is still a click away, and is what you want while editing a
   * single storey -- upper planes are ghosted and never raycast, but they are
   * still geometry on screen.
   */
  const [planeMode, setPlaneMode] = useState<PlaneSetMode>('all');
  const [showConnectors, setShowConnectors] = useState(true);
  const [showHiddenWalls, setShowHiddenWalls] = useState(true);
  const [showEntitySprites, setShowEntitySprites] = useState(true);
  const [hud, setHud] = useState({
    triangles: 0,
    sectors: 0,
    pending: 0,
    fps: 0,
    sceneryDraws: 0,
    sceneryInstances: 0,
    sceneryTriangles: 0
  });

  const modeRef = useRef<CameraMode>('orbit');
  const flyRef = useRef<Set<string>>(new Set());
  const orbitRef = useRef<OrbitState>(
    overviewOrbit(sectorCentre(activeSector?.x ?? 50, activeSector?.y ?? 50))
  );

  const cache = useMemo(() => new SectorGeometryCache(createMesher), []);
  useEffect(() => () => cache.dispose(), [cache]);

  /**
   * The other planes' lanes, read-only. See `plane-sectors.ts`.
   *
   * The store tracks exactly one plane, because that is the only one anything
   * is allowed to edit. Everything below treats these as scenery: they are
   * meshed and drawn and never written.
   */
  /**
   * Held in state, not `useMemo`, and rebuilt if it was disposed.
   *
   * StrictMode mounts, unmounts and remounts every component in development.
   * The unmount runs effect cleanups -- so the cache gets disposed -- but a
   * `useMemo` is NOT re-run on the remount, so the old
   *
   *     const planeCache = useMemo(() => new PlaneSectorCache(), []);
   *     useEffect(() => () => planeCache.dispose(), [planeCache]);
   *
   * left the component holding a disposed cache for the rest of the session.
   * A disposed cache drops every request in silence, so the viewport asked for
   * ghost planes forever and got nothing: no error, no pending, no absent, just
   * "0 read-only sectors" and a world with no upper floors. It cost an evening.
   *
   * State + an identity-keyed effect is the fix: the remount sees a disposed
   * instance, swaps in a fresh one, and the effect re-runs against that.
   */
  const [planeCache, setPlaneCache] = useState(() => new PlaneSectorCache());
  useEffect(() => {
    if (planeCache.isDisposed()) {
      setPlaneCache(new PlaneSectorCache());
      return;
    }
    return () => planeCache.dispose();
  }, [planeCache]);
  const [ghostVersion, setGhostVersion] = useState(0);
  useEffect(
    () => planeCache.subscribe(() => setGhostVersion((v) => v + 1)),
    [planeCache]
  );

  const planeSet = useMemo(() => planesFor(plane, planeMode), [plane, planeMode]);

  /**
   * The atlas -- the project's own sheet when the server has one, else bundled.
   *
   * Keyed on `config` rather than mounting once, because the scene mounts
   * before the API has opened a project and the sheet lives under the project.
   * `config` arriving is the signal that a project exists; `loadAtlas()`
   * deliberately does not memoise a too-early miss, so this second call is the
   * one that gets the real sheet. Resolving to the same result is a no-op.
   */
  const libraryVersion = props.libraryVersion ?? 0;
  const seenLibrary = useRef(libraryVersion);
  useEffect(() => {
    let alive = true;
    // A library change replaces the atlas outright; otherwise a server sheet,
    // once had, is not swapped for a later (possibly bundled) answer.
    const replace = seenLibrary.current !== libraryVersion;
    if (replace) {
      seenLibrary.current = libraryVersion;
      refreshLibraryAssets();
    }
    loadAtlas().then(
      (resolved) => {
        if (!alive) return;
        setAtlas((current) => (!replace && current?.source === 'server' ? current : resolved));
      },
      (err: unknown) => alive && setAtlasError(err instanceof Error ? err.message : String(err))
    );
    return () => {
      alive = false;
    };
  }, [config, libraryVersion]);

  /**
   * The `.ob3` models, once per session (and again after a library change).
   *
   * Keyed on `config` for the same reason the atlas is: the scene mounts before
   * a project is open, and the asset lives under the project. A miss is a normal
   * answer -- the route 404s until the importer has built the asset -- and
   * resolves to `null`, which means "draw everything except scenery" rather than
   * "draw nothing".
   */
  useEffect(() => {
    let alive = true;
    const replace = libraryVersion > 0;
    loadSceneryModels().then(
      (resolved) => alive && setModels((current) => (replace ? resolved : (current ?? resolved))),
      () => alive && setModels(null)
    );
    return () => {
      alive = false;
    };
  }, [config, libraryVersion]);

  /* sectors -> mesh queue */
  const activeSectors = useMemo(() => {
    const map = new Map<string, SectorSource>();
    for (const [key, sector] of Object.entries(sectors)) {
      if (sector.coord.plane !== plane) continue;
      map.set(key, sector);
    }
    return map;
  }, [sectors, plane]);

  /* ask for the ghost planes' sectors, read-only */
  useEffect(() => {
    if (planeSet.length <= 1) return;
    planeCache.request(planeSectorCoords(activeSectors, planeSet, plane));
  }, [planeCache, activeSectors, planeSet, plane]);

  /**
   * What gets meshed: the active plane from the store, plus whatever other
   * planes have arrived.
   *
   * The active plane always comes from props, never from the side cache, so
   * there is exactly one owner of the thing being edited and an edit can never
   * be masked by a stale read-only copy.
   */
  const meshList = useMemo(() => {
    if (planeSet.length <= 1) return activeSectors;

    const map = new Map<string, SectorSource>(activeSectors);
    const wanted = new Set(planeSet);
    for (const [key, sector] of planeCache.snapshot()) {
      if (sector.coord.plane === plane) continue;
      if (!wanted.has(sector.coord.plane)) continue;
      map.set(key, sector);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSectors, planeSet, plane, planeCache, ghostVersion]);

  // Wait for the atlas AND the models to settle before the first mesh. Either
  // arriving invalidates every geometry -- a layout change moves the uvs, and
  // models arriving means every sector was meshed without its scenery -- so
  // meshing eagerly would mesh the whole neighbourhood two or three times.
  const settled = (atlas !== null || atlasError !== null) && models !== undefined;

  useEffect(() => {
    if (!settled) return;
    if (
      cache.request(
        meshList,
        config ?? null,
        atlas ? atlas.layout : null,
        models?.source ?? null
      )
    ) {
      setVersion((v) => v + 1);
    }
  }, [cache, meshList, config, atlas, models, settled]);

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
      // WASD is also how you type; a search box or a definition form gets the
      // keys, and the camera stays put.
      if (inTextField(e.target)) {
        flyRef.current.clear();
        return;
      }
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
    // Held keys with no keyup to match: clicking into a field, or leaving the
    // window, would otherwise leave the camera drifting forever.
    const stop = () => flyRef.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', stop);
    document.addEventListener('focusin', stop);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', stop);
      document.removeEventListener('focusin', stop);
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
          fps: Math.round((frames * 1000) / (now - last)),
          sceneryDraws: stats.sceneryDraws,
          sceneryInstances: stats.sceneryInstances,
          sceneryTriangles: stats.sceneryTriangles
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
    dragRef.current = { mode: 'paint', from: tile, last: tile, downX: e.clientX, downY: e.clientY, moved: false };
    onPick(tile, { alt: e.altKey, shift: e.shiftKey, continued: false });
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
      // A click is not a drag. A hand never holds perfectly still, and raising
      // the terrain moves the surface under a stationary cursor, so without
      // this one click re-applied the tool several times and spilled onto the
      // tiles next to it.
      if (!drag.moved) {
        const dx = e.clientX - (drag.downX ?? e.clientX);
        const dy = e.clientY - (drag.downY ?? e.clientY);
        if (dx * dx + dy * dy < PAINT_DRAG_THRESHOLD_PX * PAINT_DRAG_THRESHOLD_PX) return;
        drag.moved = true;
      }
      // Each tile once per crossing: moving within a tile is not another stroke.
      if (sameTile(tile, drag.last ?? null)) return;
      const path = drag.last ? tilesBetween(drag.last, tile) : [tile];
      drag.last = tile;
      for (const step of path) onPick(step, { alt: e.altKey, shift: e.shiftKey, continued: true });
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
    // Squared up to north rather than keeping whatever yaw you were on, so the
    // preset agrees with the world map's orientation. See MAP_NORTH_YAW for the
    // half of that promise a camera cannot keep.
    orbitRef.current = clampOrbit(inGameOrbit(orbitRef.current.target, MAP_NORTH_YAW));
    setCameraMode('orbit');
  };

  const goOverview = () => {
    orbitRef.current = clampOrbit(overviewOrbit(orbitRef.current.target));
    setCameraMode('orbit');
  };

  const ready = !!config;

  /**
   * Model names that are named by the config and absent from the archive.
   *
   * The union of what the importer reported (`models.missing`) and what the
   * loaded sectors actually asked for and did not get. The shipped cache really
   * does contain one: `runiteruck1`, used by object 211 ("Rock"), is a typo for
   * the `runiterock1` entry that is in models36.jag, and the real client hits
   * the same dead end. Surfacing it is the point -- repairing it would make an
   * export differ from its import (DECISIONS section 8).
   */
  const missingModels = useMemo(
    () => [...new Set([...(models?.missing ?? []), ...cache.missingModels()])].sort(),
    [models, cache, version]
  );

  /* what the stack currently contains, for the badge */
  const stack = useMemo(() => {
    const graph = cache.connectorGraph();
    const drawn = new Set(planeSet);
    return {
      connectors: graph.placements.filter((c) => drawn.has(c.plane)).length,
      links: graph.links.filter(
        (l) => drawn.has(l.lower.plane) && drawn.has(l.upper.plane)
      ).length,
      unpaired: graph.unpaired,
      ghost: planeCache.stats(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, planeSet, version, ghostVersion, planeCache]);

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
        onPointerCancel={() => {
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
            // The ACTIVE plane's sectors only: the overlays (grid, brush,
            // selection, borders) belong to the plane being edited, and a grid
            // drawn four times over would be noise, not a precision aid.
            sectorList={activeSectors}
            planeSet={planeSet}
            showConnectors={showConnectors}
            showHiddenWalls={showHiddenWalls}
            showEntitySprites={showEntitySprites}
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
            {(hud.triangles + hud.sceneryTriangles).toLocaleString()} tris &middot; {hud.fps} fps
          </span>
          {/*
            Scenery gets its own line because "no scenery" is a state people must
            be able to see. A world with the models asset missing looks plausible
            and is not what the client draws; saying so beats a bare viewport.
          */}
          <span style={{ color: 'var(--fg-2)' }}>
            {models === undefined
              ? 'loading scenery models…'
              : models === null
                ? 'scenery: no models asset on this project — terrain, walls and roofs only'
                : `scenery: ${hud.sceneryInstances.toLocaleString()} objects in ${hud.sceneryDraws} draw${
                    hud.sceneryDraws === 1 ? '' : 's'
                  }, ${models.count} models loaded${
                    missingModels.length > 0
                      ? ` · ${missingModels.length} not in the archive (${missingModels.slice(0, 3).join(', ')}${missingModels.length > 3 ? '…' : ''})`
                      : ''
                  }`}
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
          {/*
            What the stack is showing. "planes: 0" with a ladder count of zero
            is a state people must be able to read: a building with no upper
            storey in the data looks identical to one whose upper storey failed
            to load, and only this line tells them apart.
          */}
          <span style={{ color: 'var(--fg-2)' }}>
            planes: {planeSet.map((p) => PLANE_LABELS[p] ?? p).join(' · ')}
            {planeSet.length > 1
              ? ` · ${stack.ghost.loaded} read-only sector${stack.ghost.loaded === 1 ? '' : 's'}${
                  stack.ghost.pending > 0 ? `, ${stack.ghost.pending} loading` : ''
                }${stack.ghost.absent > 0 ? `, ${stack.ghost.absent} with no data` : ''}`
              : ' (stacking off)'}
            {' · '}
            {stack.connectors} connector{stack.connectors === 1 ? '' : 's'}, {stack.links} linked
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
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 4,
            pointerEvents: 'auto'
          }}
        >
          <div style={{ display: 'flex', gap: 4 }}>
            <CameraButton active={mode === 'orbit'} onClick={() => setCameraMode('orbit')}>
              orbit
            </CameraButton>
            <CameraButton active={mode === 'fly'} onClick={() => setCameraMode('fly')}>
              fly
            </CameraButton>
            <CameraButton active={false} onClick={goInGame} title="RSC's own pitch and zoom, looking north">
              in-game
            </CameraButton>
            <CameraButton active={false} onClick={goOverview} title="Frame the whole sector, north up">
              sector
            </CameraButton>
          </div>

          {/*
            The floor control, right under the camera control and labelled, so
            "why can I only see one storey" has a visible answer. Three states
            rather than a checkbox: "everything below me" is the one people want
            when they are building an upper floor, and "all" is the one they want
            when they are looking for where a ladder goes.
          */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--fg-2)',
                background: 'rgba(13, 15, 18, 0.78)',
                padding: '3px 6px',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius)'
              }}
            >
              floors
            </span>
            <CameraButton
              active={planeMode === 'single'}
              onClick={() => setPlaneMode('single')}
              title="Only the plane being edited"
            >
              this one
            </CameraButton>
            <CameraButton
              active={planeMode === 'below'}
              onClick={() => setPlaneMode('below')}
              title="This plane and every storey under it, ghosted"
            >
              + below
            </CameraButton>
            <CameraButton
              active={planeMode === 'all'}
              onClick={() => setPlaneMode('all')}
              title="All four planes, ghosted except the one being edited"
            >
              all
            </CameraButton>
            <CameraButton
              active={showConnectors}
              onClick={() => setShowConnectors((v) => !v)}
              title="Mark ladders and staircases, and draw the link between the floors they join"
            >
              ladders
            </CameraButton>
            <CameraButton
              active={showHiddenWalls}
              onClick={() => setShowHiddenWalls((v) => !v)}
              title="Outline walls the game does not draw from the map (doors, doorframes and other placeholders)"
            >
              hidden walls
            </CameraButton>
            <CameraButton
              active={showEntitySprites}
              onClick={() => setShowEntitySprites((v) => !v)}
              title="Draw NPCs and ground items as their sprites; off shows markers"
            >
              sprites
            </CameraButton>
          </div>
        </div>
      </div>
    </div>
  );
}

const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);

/**
 * Plane numbers are file-name digits, not storeys: plane 3 is the DUNGEON and
 * sits below the ground floor, which the ladder data proves (see `planes.ts`).
 * Naming them in the badge stops "3" reading as "third floor".
 */
const PLANE_LABELS: Record<number, string> = {
  3: 'dungeon',
  0: 'ground',
  1: '1st',
  2: '2nd'
};

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
