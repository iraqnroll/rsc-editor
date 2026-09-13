import { shadeChannel, unpackFill } from './colour.js';
import { COLOUR_TRANSPARENT } from './constants.js';

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
 * {@link RscModel.build} emits **render space**: the same x and z, but
 * y = +height, so a consumer can drop the buffers into a right-handed, Y-up
 * three.js scene with no transform. Negating one axis mirrors handedness, which
 * flips which side of each triangle faces the camera; `build` compensates in
 * the winding it emits (see the comment on `emitFace`).
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

/** Plain arrays, ready to become a BufferGeometry. */
export interface GeometryData {
  /** xyz triples, render space (right-handed, Y up, 128 units per tile) */
  positions: Float32Array;
  /** rgb triples in 0..1, already shaded. Render unlit. */
  colours: Float32Array;
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

  /** `GameModel#setVertexAmbience`. Stored signed, as the client's Int8Array is. */
  setVertexAmbience(vertex: number, ambience: number): void {
    this.vertexAmbience[vertex] = (ambience << 24) >> 24;
  }

  createFace(
    vertices: number[],
    front: number,
    back: number,
    tile = -1,
    keep = true
  ): number {
    this.faces.push({ vertices, front, back, tile, keep });
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

    const faceIntensity = new Int32Array(faceCount);
    if (!settings.gouraud) {
      for (let i = 0; i < faceCount; i++) {
        faceIntensity[i] =
          ((faceNormalX[i]! * settings.x +
            faceNormalY[i]! * settings.y +
            faceNormalZ[i]! * settings.z) /
            divisor) |
          0;
      }
    }

    const vertexIntensity = new Int32Array(vertexCount);

    if (settings.gouraud) {
      const normalX = new Int32Array(vertexCount);
      const normalY = new Int32Array(vertexCount);
      const normalZ = new Int32Array(vertexCount);
      const normalCount = new Int32Array(vertexCount);

      for (let i = 0; i < faceCount; i++) {
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
      lightAmbience
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
    const uvs: number[] = [];
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
      // Negating Y on the way out mirrors handedness, so the side that the
      // client draws ends up counter-clockwise -- i.e. three.js front-facing --
      // when a back-fill face keeps the client's vertex order and a front-fill
      // face is reversed.
      const n = verts.length;
      const corner: number[] = [];
      for (let i = 0; i < n; i++) corner.push(isFront ? n - 1 - i : i);

      const base = positions.length / 3;

      // Flat normal in render space. A direction d in client space images to
      // (d.x, -d.y, d.z); the geometric normal of the render-space polygon is
      // n' = (-n.x, n.y, -n.z). The side the client draws is +n' for a back
      // fill and -n' for a front fill, so a front fill negates.
      const rawNX = -lit.faceNormalX[faceIndex]!;
      const rawNY = lit.faceNormalY[faceIndex]!;
      const rawNZ = -lit.faceNormalZ[faceIndex]!;
      const mag = Math.sqrt(rawNX * rawNX + rawNY * rawNY + rawNZ * rawNZ) || 1;
      const sign = isFront ? -1 : 1;
      const nx = (sign * rawNX) / mag;
      const ny = (sign * rawNY) / mag;
      const nz = (sign * rawNZ) / mag;

      const texture = fill >= 0 ? fill : -1;
      const baseRgb = fill < 0 ? unpackFill(fill) : { r: 255, g: 255, b: 255 };

      for (let i = 0; i < n; i++) {
        const v = verts[corner[i]!]!;

        positions.push(this.vertexX[v]!, -this.vertexY[v]!, this.vertexZ[v]!);
        normals.push(nx, ny, nz);

        // Scene#generateScanlines, exactly:
        //   visibility <  0 (front): ambience - intensity + vertexAmbience
        //   visibility >= 0 (back):  ambience + intensity + vertexAmbience
        // Note the vertex ambience is *added* in both cases -- only the
        // intensity changes sign with the facing.
        const intensity = settings.gouraud
          ? lit.vertexIntensity[v]!
          : lit.faceIntensity[faceIndex]!;
        const ambience = settings.gouraud ? this.vertexAmbience[v]! : 0;

        let shade = isFront
          ? lit.lightAmbience - intensity + ambience
          : lit.lightAmbience + intensity + ambience;

        if (options.clampShade) shade = Math.max(0, Math.min(255, shade));

        colours.push(
          shadeChannel(baseRgb.r, shade) / 255,
          shadeChannel(baseRgb.g, shade) / 255,
          shadeChannel(baseRgb.b, shade) / 255
        );
      }

      // Per-face uv. RSC textures are stretched across the whole polygon, so
      // the corners are the unit square (a triangle takes the first three).
      // Keyed on the *source* corner so reversing the winding does not mirror
      // the texture.
      const quadUv = [0, 0, 1, 0, 1, 1, 0, 1];
      for (let i = 0; i < n; i++) {
        const c = corner[i]! % 4;
        uvs.push(quadUv[c * 2]!, quadUv[c * 2 + 1]!);
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
