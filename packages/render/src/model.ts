import { shadeChannel, unpackFill } from './colour.js';
import { COLOUR_TRANSPARENT } from './constants.js';
import { RENDER_X_SIGN, renderX } from './render-space.js';

/**
 * A faithful stand-in for the client's `GameModel`, reduced to what geometry
 * building needs: vertices, n-gon faces with a front and a back fill, the
 * integer lighting model, and a conversion to flat typed arrays.
 *
 * It is deliberately not a three.js object. Nothing in `packages/render`
 * imports three.
 *
 * ## Coordinate spaces
 *
 * Vertices go in using **client space**: x = tileX * 128, z = tileY * 128,
 * y = -height (the client's "up" is negative Y). The lighting arithmetic is
 * defined in that space -- the light direction (-50, -10, -50) is meaningless
 * in any other -- so it must stay that way for face normals to come out right.
 *
 * {@link RscModel.build} emits **render space**: `diag(RENDER_X_SIGN, -1, 1)`
 * of that, i.e. y = +height so three.js can use it Y-up, and x negated so that
 * +x is EAST rather than west. See `render-space.ts` for why the x flip is
 * there and why the winding reversal in `emitFace` is the same change: the two
 * are only correct together.
 */

export interface Face {
  vertices: number[];
  /** drawn when the camera is on the +normal side; `COLOUR_TRANSPARENT` = never */
  front: number;
  /** drawn when the camera is on the -normal side */
  back: number;
  /** sector-local tile index this face came from, or -1 */
  tile: number;
  /** false for padding faces that exist only to light the sector's edge right */
  keep: boolean;
  /**
   * Per-face override of {@link LightSettings.gouraud}; `undefined` follows the
   * model-wide setting.
   *
   * The client stores shading mode per face, not per model: `faceIntensity[i]`
   * is either a real flat intensity or the `magic` sentinel, and
   * `Scene#generateScanlines` branches on that sentinel for every face it draws.
   * `_setLight_from6` (terrain, walls, roofs) stamps every face the same way,
   * which is why the model-wide flag is enough for those. `_setLight_from5`
   * -- the one scenery uses -- does NOT touch `faceIntensity` at all, so an
   * `.ob3` model keeps whatever its own illumination byte said: byte 0 leaves 0
   * (flat), anything else leaves `magic` (gouraud). A tree is therefore a
   * mixture of flat and smooth faces, and collapsing it to one mode per model
   * changes what it looks like.
   */
  gouraud?: boolean;
}

/**
 * The arguments to `GameModel#_setLight_from6`, which the client calls with a
 * different set for terrain, walls and roofs.
 */
export interface LightSettings {
  /** true -> per-vertex (smooth); false -> per-face (flat) */
  gouraud: boolean;
  ambient: number;
  diffuse: number;
  x: number;
  y: number;
  z: number;
}

/** `World#_loadSection_from4`: `gameModel._setLight_from6(true, 40, 48, ...)`. */
export const TERRAIN_LIGHT: LightSettings = {
  gouraud: true,
  ambient: 40,
  diffuse: 48,
  x: -50,
  y: -10,
  z: -50
};

/** `parentModel._setLight_from6(false, 60, 24, ...)` -- walls are flat shaded. */
export const WALL_LIGHT: LightSettings = {
  gouraud: false,
  ambient: 60,
  diffuse: 24,
  x: -50,
  y: -10,
  z: -50
};

/** `parentModel._setLight_from6(true, 50, 50, ...)`. */
export const ROOF_LIGHT: LightSettings = {
  gouraud: true,
  ambient: 50,
  diffuse: 50,
  x: -50,
  y: -10,
  z: -50
};

/**
 * `World#addModels`: `gameModel._setLight_from5(48, 48, -50, -10, -50)`.
 *
 * `_setLight_from5` takes no gouraud flag and does not reset `faceIntensity`,
 * so the `.ob3`'s own per-face illumination byte decides flat vs smooth. The
 * `gouraud` here is only the fallback for a face that does not say; the scenery
 * builder sets {@link Face.gouraud} on every face it creates.
 */
export const SCENERY_LIGHT: LightSettings = {
  gouraud: false,
  ambient: 48,
  diffuse: 48,
  x: -50,
  y: -10,
  z: -50
};

/** Plain arrays, ready to become a BufferGeometry. */
export interface GeometryData {
  /** xyz triples, render space (right-handed, Y up, 128 units per tile) */
  positions: Float32Array;
  /** rgb triples in 0..1, already shaded. Render unlit. */
  colours: Float32Array;
  /**
   * The same surfaces with the client's shading turned down to a hint of
   * relief: no directional light to speak of and no wrap. The editor's
   * "shading off" view, for painting on steep terrain, where the faithful
   * shade overflows and wraps to black (`shadeChannel`). Not client-accurate
   * and never used for anything that claims to be. Absent from geometry that
   * was merged from other geometry (scenery).
   */
  plainColours?: Float32Array;
  /** per-face uv, (0,0)-(1,1) across each source polygon */
  uvs: Float32Array;
  /** flat face normal, render space, repeated per vertex */
  normals: Float32Array;
  indices: Uint32Array;
  /** per triangle: RSC texture id, or -1 when the face is a flat colour */
  triangleTextures: Int32Array;
  /** per triangle: sector-local tile index (`tileX * 48 + tileY`), or -1 */
  triangleTiles: Int32Array;
  vertexCount: number;
  triangleCount: number;
}

export interface BuildOptions {
  /**
   * Clamp shades into 0..255 instead of letting them wrap.
   *
   * The client masks (`ramp[(s >> 8) & 0xff]`), so an over-bright or negative
   * shade wraps around and produces a speckle. Faithful is the default;
   * clamping is available for screenshots where the artefact is a distraction.
   */
  clampShade?: boolean;
}

/**
 * How much of the lit shade's departure from level ground the "shading off"
 * view keeps: enough to read a slope, never enough to wrap.
 */
const PLAIN_RELIEF = 0.25;

export function emptyGeometry(): GeometryData {
  return {
    positions: new Float32Array(0),
    colours: new Float32Array(0),
    uvs: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    triangleTextures: new Int32Array(0),
    triangleTiles: new Int32Array(0),
    vertexCount: 0,
    triangleCount: 0
  };
}

/**
 * Solve each vertex of a polygon into the (v0->v1, v0->vLast) basis the client
 * textures it with.
 *
 * For the shapes this package emits -- triangles and planar parallelograms --
 * this is exact, and it collapses to the obvious corner table. It is written as
 * a projection rather than a table so an n-gon (which a `.ob3` model can carry)
 * gets the *plane's* uv at each corner, which is what the client's per-pixel
 * plane evaluation would have produced there.
 *
 * Returns a flat `[u0, v0, u1, v1, ...]`, one pair per input vertex.
 */
export function faceUvs(points: ReadonlyArray<readonly [number, number, number]>): number[] {
  const n = points.length;
  const out = new Array<number>(n * 2).fill(0);
  if (n < 3) return out;

  const o = points[0]!;
  const p1 = points[1]!;
  const p2 = points[n - 1]!;

  const ax = p1[0] - o[0];
  const ay = p1[1] - o[1];
  const az = p1[2] - o[2];
  const bx = p2[0] - o[0];
  const by = p2[1] - o[1];
  const bz = p2[2] - o[2];

  const aa = ax * ax + ay * ay + az * az;
  const bb = bx * bx + by * by + bz * bz;
  const ab = ax * bx + ay * by + az * bz;
  const det = aa * bb - ab * ab;

  // Degenerate face (the two axes are parallel, or one has no length): the
  // client's texture plane is undefined here too. Leave the face at uv 0.
  if (det === 0) return out;

  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const px = p[0] - o[0];
    const py = p[1] - o[1];
    const pz = p[2] - o[2];
    const pa = px * ax + py * ay + pz * az;
    const pb = px * bx + py * by + pz * bz;
    out[i * 2] = (pa * bb - pb * ab) / det;
    out[i * 2 + 1] = (pb * aa - pa * ab) / det;
  }

  return out;
}

export class RscModel {
  readonly vertexX: number[] = [];
  readonly vertexY: number[] = [];
  readonly vertexZ: number[] = [];
  /** `GameModel#vertexAmbience`, an Int8Array in the client: -128..127 */
  readonly vertexAmbience: number[] = [];
  readonly faces: Face[] = [];

  private readonly lookup = new Map<string, number>();

  /**
   * `GameModel#vertexAt`: return the existing vertex at exactly these
   * coordinates, or create one. The client linear-scans; a keyed map gives the
   * same answer (first created wins) without the quadratic cost.
   */
  vertexAt(x: number, y: number, z: number): number {
    const key = `${x},${y},${z}`;
    const found = this.lookup.get(key);
    if (found !== undefined) return found;

    const index = this.vertexX.length;
    this.vertexX.push(x);
    this.vertexY.push(y);
    this.vertexZ.push(z);
    this.vertexAmbience.push(0);
    this.lookup.set(key, index);
    return index;
  }

  /**
   * Append a vertex unconditionally, skipping the `vertexAt` coincidence check.
   *
   * Needed by the scenery builder, which has to reproduce the client's ORDER of
   * operations: `GameModel#copy` merges the source model -- deduplicating on the
   * raw `.ob3` coordinates -- and only then applies the yaw. Two distinct source
   * vertices can land on the same point once the integer rotation has rounded
   * them, and the client keeps those separate. Feeding rotated coordinates to
   * `vertexAt` would merge them, which silently changes the smoothed normals.
   */
  pushVertex(x: number, y: number, z: number): number {
    const index = this.vertexX.length;
    this.vertexX.push(x);
    this.vertexY.push(y);
    this.vertexZ.push(z);
    this.vertexAmbience.push(0);
    return index;
  }

  /** `GameModel#setVertexAmbience`. Stored signed, as the client's Int8Array is. */
  setVertexAmbience(vertex: number, ambience: number): void {
    this.vertexAmbience[vertex] = (ambience << 24) >> 24;
  }

  createFace(
    vertices: number[],
    front: number,
    back: number,
    tile = -1,
    keep = true,
    gouraud?: boolean
  ): number {
    this.faces.push({ vertices, front, back, tile, keep, gouraud });
    return this.faces.length - 1;
  }

  /**
   * `GameModel#relight` + `GameModel#light`, run over the untransformed
   * vertices (for the world models the client's transform is the identity, so
   * transformed == model coordinates).
   *
   * Returns integer face normals scaled by 256, per-face intensities, and the
   * per-vertex intensities used when the model is gouraud shaded.
   */
  light(settings: LightSettings): {
    faceNormalX: Int32Array;
    faceNormalY: Int32Array;
    faceNormalZ: Int32Array;
    faceIntensity: Int32Array;
    vertexIntensity: Int32Array;
    lightAmbience: number;
    /** the intensity divisor, for a caller that needs one more dot product */
    divisor: number;
  } {
    const faceCount = this.faces.length;
    const vertexCount = this.vertexX.length;

    const faceNormalX = new Int32Array(faceCount);
    const faceNormalY = new Int32Array(faceCount);
    const faceNormalZ = new Int32Array(faceCount);

    for (let i = 0; i < faceCount; i++) {
      const verts = this.faces[i]!.vertices;
      const a = verts[0]!;
      const b = verts[1]!;
      const c = verts[2]!;

      const aX = this.vertexX[a]!;
      const aY = this.vertexY[a]!;
      const aZ = this.vertexZ[a]!;
      const bX = this.vertexX[b]! - aX;
      const bY = this.vertexY[b]! - aY;
      const bZ = this.vertexZ[b]! - aZ;
      const cX = this.vertexX[c]! - aX;
      const cY = this.vertexY[c]! - aY;
      const cZ = this.vertexZ[c]! - aZ;

      let normX = bY * cZ - cY * bZ;
      let normY = bZ * cX - cZ * bX;
      let normZ = bX * cY - cX * bY;

      // Halve until it fits the client's 14-bit working range. This is why the
      // normals are only approximately proportional between faces.
      while (
        normX > 8192 ||
        normY > 8192 ||
        normZ > 8192 ||
        normX < -8192 ||
        normY < -8192 ||
        normZ < -8192
      ) {
        normX >>= 1;
        normY >>= 1;
        normZ >>= 1;
      }

      let normMag =
        (256 * Math.sqrt(normX * normX + normY * normY + normZ * normZ)) | 0;
      if (normMag <= 0) normMag = 1;

      faceNormalX[i] = ((normX * 0x10000) / normMag) | 0;
      faceNormalY[i] = ((normY * 0x10000) / normMag) | 0;
      // 65535, not 0x10000. Present in mudclient; kept verbatim.
      faceNormalZ[i] = ((normZ * 65535) / normMag) | 0;
    }

    const lightAmbience = 256 - settings.ambient * 4;
    const lightDiffuse = (64 - settings.diffuse) * 16 + 128;
    const magnitude =
      Math.sqrt(
        settings.x * settings.x +
          settings.y * settings.y +
          settings.z * settings.z
      ) | 0;
    const divisor = (lightDiffuse * magnitude) >> 8;

    // `GameModel#light`, which branches per face on the `magic` sentinel:
    // a non-magic face gets a flat intensity, a magic one contributes its
    // normal to its vertices instead. Our `Face.gouraud` is that sentinel.
    const isGouraud = (i: number): boolean =>
      this.faces[i]!.gouraud ?? settings.gouraud;

    const faceIntensity = new Int32Array(faceCount);
    let anyGouraud = false;

    for (let i = 0; i < faceCount; i++) {
      if (isGouraud(i)) {
        anyGouraud = true;
        continue;
      }
      faceIntensity[i] =
        ((faceNormalX[i]! * settings.x +
          faceNormalY[i]! * settings.y +
          faceNormalZ[i]! * settings.z) /
          divisor) |
        0;
    }

    const vertexIntensity = new Int32Array(vertexCount);

    if (anyGouraud) {
      const normalX = new Int32Array(vertexCount);
      const normalY = new Int32Array(vertexCount);
      const normalZ = new Int32Array(vertexCount);
      const normalCount = new Int32Array(vertexCount);

      for (let i = 0; i < faceCount; i++) {
        if (!isGouraud(i)) continue;
        for (const v of this.faces[i]!.vertices) {
          normalX[v]! += faceNormalX[i]!;
          normalY[v]! += faceNormalY[i]!;
          normalZ[v]! += faceNormalZ[i]!;
          normalCount[v]!++;
        }
      }

      for (let v = 0; v < vertexCount; v++) {
        if (normalCount[v]! > 0) {
          vertexIntensity[v] =
            ((normalX[v]! * settings.x +
              normalY[v]! * settings.y +
              normalZ[v]! * settings.z) /
              (divisor * normalCount[v]!)) |
            0;
        }
      }
    }

    return {
      faceNormalX,
      faceNormalY,
      faceNormalZ,
      faceIntensity,
      vertexIntensity,
      lightAmbience,
      divisor
    };
  }

  /**
   * Light the model and flatten it to typed arrays.
   *
   * Vertices are NOT shared between output triangles. They cannot be: the shade
   * of a vertex depends on which face it belongs to (flat shading) and on which
   * side of that face is being drawn, and a face with two opaque sides is
   * emitted twice with opposite winding.
   */
  build(settings: LightSettings, options: BuildOptions = {}): GeometryData {
    const lit = this.light(settings);

    const positions: number[] = [];
    const colours: number[] = [];
    const plainColours: number[] = [];
    const uvs: number[] = [];

    // The shade a level, upward-facing surface gets: the "shading off" view is
    // pinned to it, so flat ground reads the same with shading on or off.
    // `faceNormalY` of a level face is -256 in client space (Y is down), front
    // side up, and a front fill SUBTRACTS its intensity.
    const levelShade = lit.lightAmbience - (((-256 * settings.y) / lit.divisor) | 0);
    const normals: number[] = [];
    const indices: number[] = [];
    const triangleTextures: number[] = [];
    const triangleTiles: number[] = [];

    const emitFace = (
      faceIndex: number,
      fill: number,
      /** true when the client draws this face's *front* fill */
      isFront: boolean
    ): void => {
      const face = this.faces[faceIndex]!;
      const verts = face.vertices;

      // Sign convention, established from the terrain quads: the client draws
      // the front fill when the camera is on the +normal side, and the back
      // fill otherwise, with the intensity subtracted in the first case and
      // added in the second (Scene#generateScanlines, `polygon.visibility`).
      //
      // ====================================================================
      //  WINDING. THIS IS THE OTHER HALF OF `RENDER_X_SIGN`; THE TWO ARE ONE
      //  CHANGE AND MUST MOVE TOGETHER. See render-space.ts.
      // ====================================================================
      //
      // Render space is client space through T = diag(RENDER_X_SIGN, -1, 1),
      // so det(T) = -RENDER_X_SIGN. Emitting the source vertex order gives a
      // triangle whose right-hand-rule normal is `det(T) * T^-T * n`, while
      // the side the CLIENT draws is `+T^-T * n` for a front fill and
      // `-T^-T * n` for a back fill. They agree -- i.e. the drawn side is the
      // three.js front face -- exactly when `(isFront ? 1 : -1)` equals
      // `-RENDER_X_SIGN`; otherwise the order has to be reversed.
      //
      // At RENDER_X_SIGN = +1 that reverses front fills (the old, mirrored
      // space). At -1 it reverses back fills instead. Flip one without the
      // other and every surface shows the face it is meant to hide: roofs
      // become visible only from underneath, walls only from inside.
      const reverse = isFront === (RENDER_X_SIGN > 0);
      const n = verts.length;
      const corner: number[] = [];
      for (let i = 0; i < n; i++) corner.push(reverse ? n - 1 - i : i);

      const base = positions.length / 3;

      // Flat normal in render space, pointing at the side being drawn. A
      // "which side is visible" normal is defined by a half-space test, so it
      // maps by T^-T = diag(RENDER_X_SIGN, -1, 1) with NO determinant factor,
      // and the front/back fill supplies the sign.
      const sign = isFront ? 1 : -1;
      const rawNX = RENDER_X_SIGN * lit.faceNormalX[faceIndex]!;
      const rawNY = -lit.faceNormalY[faceIndex]!;
      const rawNZ = lit.faceNormalZ[faceIndex]!;
      const mag = Math.sqrt(rawNX * rawNX + rawNY * rawNY + rawNZ * rawNZ) || 1;
      const nx = (sign * rawNX) / mag;
      const ny = (sign * rawNY) / mag;
      const nz = (sign * rawNZ) / mag;

      const texture = fill >= 0 ? fill : -1;
      const baseRgb = fill < 0 ? unpackFill(fill) : { r: 255, g: 255, b: 255 };

      for (let i = 0; i < n; i++) {
        const v = verts[corner[i]!]!;

        // The mirror itself: T = diag(RENDER_X_SIGN, -1, 1). Every position in
        // the package passes through this one line.
        positions.push(renderX(this.vertexX[v]!), -this.vertexY[v]!, this.vertexZ[v]!);
        normals.push(nx, ny, nz);

        // Scene#generateScanlines, exactly:
        //   visibility <  0 (front): ambience - intensity + vertexAmbience
        //   visibility >= 0 (back):  ambience + intensity + vertexAmbience
        // Note the vertex ambience is *added* in both cases -- only the
        // intensity changes sign with the facing.
        const gouraud = face.gouraud ?? settings.gouraud;
        const intensity = gouraud
          ? lit.vertexIntensity[v]!
          : lit.faceIntensity[faceIndex]!;
        const ambience = gouraud ? this.vertexAmbience[v]! : 0;

        let shade = isFront
          ? lit.lightAmbience - intensity + ambience
          : lit.lightAmbience + intensity + ambience;

        const plain = Math.max(
          0,
          Math.min(255, (levelShade + (shade - levelShade) * PLAIN_RELIEF) | 0)
        );
        plainColours.push(
          shadeChannel(baseRgb.r, plain) / 255,
          shadeChannel(baseRgb.g, plain) / 255,
          shadeChannel(baseRgb.b, plain) / 255
        );

        if (options.clampShade) shade = Math.max(0, Math.min(255, shade));

        colours.push(
          shadeChannel(baseRgb.r, shade) / 255,
          shadeChannel(baseRgb.g, shade) / 255,
          shadeChannel(baseRgb.b, shade) / 255
        );
      }

      // Per-face uv, from `Scene#rasterize`'s texture plane.
      //
      // The client does not store uvs. For a textured polygon it builds a plane
      // out of three of the face's own vertices and evaluates it per pixel:
      //
      //     i1 = ai[0];            // origin        = vertex[0]
      //     i3 = i1 - ai[1];       // one axis, to  vertex[1]
      //     k--;                   // k = vertexCount - 1
      //     i6 = ai[k] - i1;       // other axis, to vertex[LAST]
      //
      // So the texture is stretched once across v0->v1 (u) and once across
      // v0->v_last (v). For a quad that is the unit square in vertex order; for
      // a TRIANGLE it makes vertex 2 the v axis, i.e. uv (0,1) and not (1,1) --
      // taking "the first three corners of the quad table" shears the texture on
      // every split tile, which is why this is derived rather than tabulated.
      //
      // Keyed on the *source* corner and solved in CLIENT space, so neither the
      // winding reversal nor `RENDER_X_SIGN` mirrors the texture relative to the
      // surface it sits on. (The world as a whole is unmirrored by
      // RENDER_X_SIGN, textures included -- that is the point of it.)
      const uvOf = faceUvs(
        verts.map((v) => [this.vertexX[v]!, this.vertexY[v]!, this.vertexZ[v]!])
      );
      for (let i = 0; i < n; i++) {
        const c = corner[i]!;
        uvs.push(uvOf[c * 2]!, uvOf[c * 2 + 1]!);
      }

      // Fan triangulation. Only ever applied to polygons the client itself
      // guarantees planar (see the `i17 === 0` test in the terrain builder and
      // the equal-height tests in the roof builder).
      for (let i = 1; i + 1 < n; i++) {
        indices.push(base, base + i, base + i + 1);
        triangleTextures.push(texture);
        triangleTiles.push(face.tile);
      }
    };

    for (let i = 0; i < this.faces.length; i++) {
      const face = this.faces[i]!;
      if (!face.keep) continue;
      if (face.front !== COLOUR_TRANSPARENT) emitFace(i, face.front, true);
      if (face.back !== COLOUR_TRANSPARENT) emitFace(i, face.back, false);
    }

    return {
      positions: new Float32Array(positions),
      colours: new Float32Array(colours),
      plainColours: new Float32Array(plainColours),
      uvs: new Float32Array(uvs),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      triangleTextures: new Int32Array(triangleTextures),
      triangleTiles: new Int32Array(triangleTiles),
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3
    };
  }
}
