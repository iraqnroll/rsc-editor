/**
 * Sector storage.
 *
 * Payloads go in and come out as the packed frame from `@rsc-editor/schema`'s
 * `encodeSectorFrame` -- this layer never decodes one. A sector fetch is
 * therefore a single row read and a `Buffer` handed straight to the socket.
 */

import { and, asc, between, eq, sql } from 'drizzle-orm';
import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  SECTOR_FRAME_BYTES,
  type SectorCoord
} from '@rsc-editor/schema';
import type { Executor } from './client.js';
import { sectors, type SectorRow } from './schema.js';

/** A rectangular window of sector coordinates on one plane. */
export interface SectorBox {
  plane: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * The box the editor streams around the camera, clamped to the world.
 *
 * Pure and total -- this is the part of the radius query that is worth unit
 * testing without a database, because the off-by-one at the world edge is
 * where a streaming bug would actually live.
 */
export function sectorRadiusBox(centre: SectorCoord, radius: number): SectorBox {
  if (!Number.isInteger(radius) || radius < 0) {
    throw new Error(`sectorRadiusBox: radius must be a non-negative integer`);
  }
  const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), hi);
  return {
    plane: clamp(centre.plane, MAX_PLANES - 1),
    minX: clamp(centre.x - radius, MAX_X_SECTORS - 1),
    maxX: clamp(centre.x + radius, MAX_X_SECTORS - 1),
    minY: clamp(centre.y - radius, MAX_Y_SECTORS - 1),
    maxY: clamp(centre.y + radius, MAX_Y_SECTORS - 1)
  };
}

/** The 8 neighbours a lock holder gets read-consistency on. See PLAN.md. */
export function neighbourCoords(centre: SectorCoord): SectorCoord[] {
  const out: SectorCoord[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = centre.x + dx;
      const y = centre.y + dy;
      if (x < 0 || x >= MAX_X_SECTORS || y < 0 || y >= MAX_Y_SECTORS) continue;
      out.push({ plane: centre.plane, x, y });
    }
  }
  return out;
}

export async function getSector(
  db: Executor,
  projectId: string,
  coord: SectorCoord
): Promise<SectorRow | undefined> {
  const rows = await db
    .select()
    .from(sectors)
    .where(
      and(
        eq(sectors.projectId, projectId),
        eq(sectors.plane, coord.plane),
        eq(sectors.x, coord.x),
        eq(sectors.y, coord.y)
      )
    )
    .limit(1);
  return rows[0];
}

/**
 * Every sector in a box, ordered so the client receives them in a stable,
 * cache-friendly order.
 *
 * Rides `sectors_project_coord_key` -- equality on (project_id, plane) then
 * ranges on x and y, which is exactly that btree's column order.
 */
export function sectorsInBoxQuery(
  db: Executor,
  projectId: string,
  box: SectorBox
) {
  return db
    .select()
    .from(sectors)
    .where(
      and(
        eq(sectors.projectId, projectId),
        eq(sectors.plane, box.plane),
        between(sectors.x, box.minX, box.maxX),
        between(sectors.y, box.minY, box.maxY)
      )
    )
    .orderBy(asc(sectors.x), asc(sectors.y));
}

export async function getSectorsInBox(
  db: Executor,
  projectId: string,
  box: SectorBox
): Promise<SectorRow[]> {
  return sectorsInBoxQuery(db, projectId, box);
}

/** Coordinates and versions only -- for a client deciding what to re-fetch. */
export async function getSectorVersions(
  db: Executor,
  projectId: string,
  box: SectorBox
): Promise<Array<Pick<SectorRow, 'plane' | 'x' | 'y' | 'version'>>> {
  return db
    .select({
      plane: sectors.plane,
      x: sectors.x,
      y: sectors.y,
      version: sectors.version
    })
    .from(sectors)
    .where(
      and(
        eq(sectors.projectId, projectId),
        eq(sectors.plane, box.plane),
        between(sectors.x, box.minX, box.maxX),
        between(sectors.y, box.minY, box.maxY)
      )
    )
    .orderBy(asc(sectors.x), asc(sectors.y));
}

export interface PutSectorInput {
  projectId: string;
  coord: SectorCoord;
  payload: Uint8Array;
  members?: boolean;
  updatedBy?: string | null;
}

/**
 * Insert or replace a sector payload, bumping `version`.
 *
 * Used by the cache importer and, after an op batch has been sequenced, by the
 * realtime layer. The version bump is done in SQL (`version + 1`) so two
 * writers cannot both compute the same next version.
 */
export async function putSector(
  db: Executor,
  input: PutSectorInput
): Promise<SectorRow> {
  assertFrameLength(input.payload);

  const rows = await db
    .insert(sectors)
    .values({
      projectId: input.projectId,
      plane: input.coord.plane,
      x: input.coord.x,
      y: input.coord.y,
      payload: input.payload,
      members: input.members ?? false,
      updatedBy: input.updatedBy ?? null,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: [sectors.projectId, sectors.plane, sectors.x, sectors.y],
      set: {
        payload: input.payload,
        members: input.members ?? false,
        version: sql`${sectors.version} + 1`,
        updatedBy: input.updatedBy ?? null,
        updatedAt: new Date()
      }
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('putSector: upsert returned no row');
  return row;
}

/**
 * Compare-and-swap write. Returns undefined when `expectedVersion` no longer
 * matches, which is how a stale optimistic client edit is rejected rather than
 * clobbering someone else's work.
 */
export async function putSectorIfVersion(
  db: Executor,
  input: PutSectorInput & { expectedVersion: number }
): Promise<SectorRow | undefined> {
  assertFrameLength(input.payload);

  const rows = await db
    .update(sectors)
    .set({
      payload: input.payload,
      version: sql`${sectors.version} + 1`,
      updatedBy: input.updatedBy ?? null,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(sectors.projectId, input.projectId),
        eq(sectors.plane, input.coord.plane),
        eq(sectors.x, input.coord.x),
        eq(sectors.y, input.coord.y),
        eq(sectors.version, input.expectedVersion)
      )
    )
    .returning();

  return rows[0];
}

/**
 * The frame length is fixed by the format (`SECTOR_FRAME_BYTES`). Checking it
 * here means a truncated write is caught at the boundary rather than surfacing
 * as "bad magic" in a worker thread three layers away -- the exact failure mode
 * DECISIONS §7 describes.
 */
function assertFrameLength(payload: Uint8Array): void {
  if (payload.byteLength !== SECTOR_FRAME_BYTES) {
    throw new Error(
      `sector payload: expected ${SECTOR_FRAME_BYTES} bytes, got ${payload.byteLength}`
    );
  }
}
