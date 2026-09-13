import type { LoadedSector } from '@rsc-editor/cache';
import { decodeSectorFrame } from '@rsc-editor/schema';
import type { Database } from '@rsc-editor/db';

/**
 * Read a project's sectors back out of Postgres in a form `exportLandscape`
 * accepts.
 *
 * ## The ordering is load-bearing
 *
 * A `.jag` archive stores its entries in insertion order, so the order sectors
 * are handed to `exportLandscape` decides the layout of the produced archive.
 * `loadLandscape` scans plane (outer), then y, then x, and its `Map` preserves
 * first-insertion order -- so reproducing the source archives byte-for-byte
 * requires feeding them back in exactly that order.
 *
 * `ORDER BY plane, y, x` is therefore not cosmetic, and it is deliberately *not*
 * the `(plane, x, y)` order the sector index and the streaming route use.
 * Sorting by x first still produces a cache a client reads identically, but it
 * is a different file -- and "different file" is indistinguishable from
 * "corrupted file" when the whole point of the gate is a byte comparison.
 *
 * Queries go through the relational builder because it hands the operators to a
 * callback: `drizzle-orm` is a dependency of `@rsc-editor/db`, not of this tool,
 * and importing it here would mean a lockfile write.
 */
export async function readSectorsForExport(
  db: Database,
  projectId: string
): Promise<LoadedSector[]> {
  const rows = await db.query.sectors.findMany({
    columns: { plane: true, x: true, y: true, members: true, payload: true },
    where: (t, { eq }) => eq(t.projectId, projectId),
    orderBy: (t, { asc }) => [asc(t.plane), asc(t.y), asc(t.x)]
  });

  return rows.map((row) => {
    // The bytea arrives as a Buffer view onto a larger pool, and
    // decodeSectorFrame takes an ArrayBuffer whose length IS the frame. Copy the
    // exact window rather than handing over `payload.buffer`, which would carry
    // the rest of the pool with it and fail the length check.
    const copy = new Uint8Array(row.payload.byteLength);
    copy.set(row.payload);
    const frame = decodeSectorFrame(copy.buffer);

    if (
      frame.coord.plane !== row.plane ||
      frame.coord.x !== row.x ||
      frame.coord.y !== row.y
    ) {
      throw new Error(
        `sector ${row.plane}/${row.x}/${row.y}: frame header says ` +
          `${frame.coord.plane}/${frame.coord.x}/${frame.coord.y}`
      );
    }

    return {
      coord: frame.coord,
      // The column is the authority for the .mem/.jag split; the frame flag
      // mirrors it, and `putSector` writes both from the same value.
      members: row.members,
      buffers: frame.buffers
    };
  });
}

/** Coordinates only -- for counting and for the idempotence check. */
export async function countSectors(
  db: Database,
  projectId: string
): Promise<{ total: number; free: number; members: number }> {
  const rows = await db.query.sectors.findMany({
    columns: { members: true },
    where: (t, { eq }) => eq(t.projectId, projectId)
  });

  const members = rows.filter((r) => r.members).length;
  return { total: rows.length, free: rows.length - members, members };
}
