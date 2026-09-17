import { z } from 'zod';
import { entityDataSchema } from './entities.js';
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

/**
 * Add, change or remove one server-side placement (NPC, item, door).
 *
 * Carries both sides like every other op: `from` is null for an add, `to` is
 * null for a remove. The server applies it only if the entity's current state
 * is `from`, so a stale client cannot overwrite a peer's change. The entity
 * stays in `sector` for its whole life; moving it to another sector is a
 * remove there and an add here, each under its own lock.
 */
export const entityOpKindSchema = z.enum(['entity.add', 'entity.update', 'entity.remove']);
export type EntityOpKind = z.infer<typeof entityOpKindSchema>;

export const entityOpSchema = z
  .object({
    type: z.literal('entity'),
    id: z.string().uuid(),
    sector: sectorCoordSchema,
    kind: entityOpKindSchema,
    /** the entity's own id, stable across its edits */
    entity: z.string().uuid(),
    from: entityDataSchema.nullable(),
    to: entityDataSchema.nullable()
  })
  .refine(
    (op) =>
      op.kind === 'entity.add'
        ? op.from === null && op.to !== null
        : op.kind === 'entity.remove'
          ? op.from !== null && op.to === null
          : op.from !== null && op.to !== null && op.from.kind === op.to.kind,
    'entity op sides do not match its kind'
  );
export type EntityOp = z.infer<typeof entityOpSchema>;

export const opSchema = z.union([sectorOpSchema, definitionOpSchema, entityOpSchema]);
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
  if (op.type === 'entity') {
    const kind =
      op.kind === 'entity.add' ? 'entity.remove' : op.kind === 'entity.remove' ? 'entity.add' : op.kind;
    return { ...op, kind, from: op.to, to: op.from };
  }
  return { ...op, from: op.to, to: op.from };
}
