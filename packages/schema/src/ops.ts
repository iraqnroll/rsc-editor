import { z } from 'zod';
import { sectorCoordSchema, tileIndexSchema, SECTOR_LANES } from './sector.js';

/**
 * Edit operations.
 *
 * Design note -- why ops carry explicit before/after values rather than intent:
 *
 * Every edit reduces to a list of (tile, lane, from, to) deltas. A 12-tile
 * elevation brush, a rectangle fill and a single wall placement are all the
 * same primitive with a different `kind` label. This buys three things:
 *
 *   - undo/redo is trivial and exact (swap `from` and `to`)
 *   - application is deterministic and order-independent per lane, so replaying
 *     the op log always reproduces the same sector
 *   - the server can validate an op without re-running brush maths
 *
 * `kind` is retained purely so the history UI can say "raised terrain" instead
 * of "changed 12 tiles".
 *
 * An op targets exactly ONE sector. This is what enforces the locking rule: a
 * tool whose brush spills across a sector boundary must emit one op per sector,
 * and the server rejects any op for a sector the author does not hold. There is
 * no way to express a cross-sector write in a single op.
 */

export const laneSchema = z.enum(SECTOR_LANES);
export type Lane = z.infer<typeof laneSchema>;

export const tileDeltaSchema = z.object({
  /** tileX * 48 + tileY */
  i: tileIndexSchema,
  lane: laneSchema,
  from: z.number().int(),
  to: z.number().int()
});
export type TileDelta = z.infer<typeof tileDeltaSchema>;

export const opKindSchema = z.enum([
  'elevation.raise',
  'elevation.lower',
  'elevation.smooth',
  'elevation.flatten',
  'paint.colour',
  'paint.overlay',
  'wall.set',
  'wall.clear',
  'roof.set',
  'scenery.place',
  'scenery.rotate',
  'scenery.remove',
  'region.fill',
  'region.paste'
]);
export type OpKind = z.infer<typeof opKindSchema>;

/** A single atomic, invertible edit to one sector. */
export const sectorOpSchema = z.object({
  type: z.literal('sector'),
  /** client-generated uuid; used to reconcile the optimistic local apply */
  id: z.string().uuid(),
  sector: sectorCoordSchema,
  kind: opKindSchema,
  changes: z.array(tileDeltaSchema).min(1).max(8192)
});
export type SectorOp = z.infer<typeof sectorOpSchema>;

/** An edit to one entity/config definition. */
export const definitionOpSchema = z.object({
  type: z.literal('definition'),
  id: z.string().uuid(),
  kind: z.literal('definition.update'),
  defKind: z.string(),
  index: z.number().int().min(0),
  /** JSON-patch-ish: whole-field replacement, keyed by field name. */
  from: z.record(z.unknown()),
  to: z.record(z.unknown())
});
export type DefinitionOp = z.infer<typeof definitionOpSchema>;

export const opSchema = z.discriminatedUnion('type', [
  sectorOpSchema,
  definitionOpSchema
]);
export type Op = z.infer<typeof opSchema>;

/** An op as persisted and broadcast, once the server has sequenced it. */
export const sequencedOpSchema = z.object({
  seq: z.number().int().positive(),
  projectId: z.string().uuid(),
  actorId: z.string().uuid(),
  createdAt: z.string().datetime(),
  op: opSchema
});
export type SequencedOp = z.infer<typeof sequencedOpSchema>;

/** Exact inverse of an op, for undo. */
export function invert(op: Op): Op {
  if (op.type === 'sector') {
    return {
      ...op,
      changes: op.changes.map((c) => ({ ...c, from: c.to, to: c.from }))
    };
  }
  return { ...op, from: op.to, to: op.from };
}
