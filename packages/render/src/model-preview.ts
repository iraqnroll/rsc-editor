import { renderX } from './render-space.js';
import type { Camera } from './software-raster.js';
import type { SceneryModel } from './scenery.js';

/**
 * Framing one `.ob3` model for a thumbnail.
 *
 * Framework-agnostic, like everything else here: it returns a camera, and the
 * caller decides whether to feed it to {@link ./software-raster.js#rasterize} or
 * to a three.js `PerspectiveCamera`. A picker renders dozens of these, so the
 * intended path is the software rasteriser -- forty WebGL contexts is not a
 * thing a browser will give you.
 *
 * The models vary by two orders of magnitude in size (a mushroom is 56 units
 * tall, a tree is 283, a shop sign hangs between 220 and 368 and never touches
 * the ground), so a fixed camera shows most of them as a dot or a wall of
 * colour. This fits the camera to the model's own bounds instead.
 */

export interface ModelPreviewFraming {
  /**
   * Horizontal angle, radians. 0 looks down -z; the default is a three-quarter
   * view, which is the angle a model reads best from and is roughly what the
   * game camera gives you.
   */
  yaw?: number;
  /** Vertical angle, radians above the horizon. */
  pitch?: number;
  /** Vertical field of view, radians. */
  fov?: number;
  /**
   * Multiplier on the fitted distance. 1 fills the frame; the default leaves a
   * margin, because a fitted bounding sphere touches the frame edge and a
   * thumbnail that touches its own border looks broken.
   */
  zoom?: number;
}

/** Bounds of a model in RENDER space (y up), which is where previews live. */
export function modelBounds(model: SceneryModel): {
  min: [number, number, number];
  max: [number, number, number];
  centre: [number, number, number];
  radius: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const vertex of model.vertices) {
    // The same transform `RscModel.build` applies, so these bounds describe what
    // will actually be drawn: client "up" is -y and render space is +y, and
    // render x is mirrored so +x is east (`render-space.ts`). Both are written
    // as subtractions so a zero stays +0 -- `-0` is legal and annoying to
    // assert against.
    //
    // The x flip matters here even though most models straddle their own
    // origin: an off-centre one (a shop sign, a fence post) would otherwise be
    // framed on the mirror image of where its geometry is, and the thumbnail
    // would cut it in half for a reason nothing in the picker could explain.
    const y = 0 - vertex.y;
    const x = renderX(vertex.x);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (vertex.z < minZ) minZ = vertex.z;
    if (vertex.z > maxZ) maxZ = vertex.z;
  }

  if (!Number.isFinite(minX)) {
    return { min: [0, 0, 0], max: [0, 0, 0], centre: [0, 0, 0], radius: 1 };
  }

  const centre: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2
  ];

  // Half the diagonal: a sphere that certainly contains the model, which is
  // what the distance below is solved against.
  const radius =
    Math.max(
      Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2,
      1
    );

  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], centre, radius };
}

/**
 * A camera that frames `model` completely, whatever its size.
 *
 * Distance is solved from the bounding sphere and the field of view rather than
 * guessed, so the tallest model in the cache and the smallest are both readable
 * at the same thumbnail size.
 */
export function modelPreviewCamera(
  model: SceneryModel,
  framing: ModelPreviewFraming = {}
): Camera {
  const yaw = framing.yaw ?? Math.PI / 4;
  const pitch = framing.pitch ?? Math.PI / 7;
  const fov = framing.fov ?? Math.PI / 4;
  const zoom = framing.zoom ?? 1.25;

  const { centre, radius } = modelBounds(model);
  const distance = (radius / Math.sin(fov / 2)) * zoom;

  const horizontal = Math.cos(pitch) * distance;

  return {
    eye: [
      centre[0] + Math.sin(yaw) * horizontal,
      centre[1] + Math.sin(pitch) * distance,
      centre[2] + Math.cos(yaw) * horizontal
    ],
    target: centre,
    fov,
    // A near plane proportional to the subject: a fixed one either clips a
    // mushroom away or wastes all the depth range on a tree.
    near: Math.max(0.5, radius / 100)
  };
}
