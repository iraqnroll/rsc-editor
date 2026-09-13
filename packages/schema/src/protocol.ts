import { z } from 'zod';
import { sectorCoordSchema } from './sector.js';
import { opSchema, sequencedOpSchema } from './ops.js';

/**
 * WebSocket protocol.
 *
 * Control messages are JSON. Sector payloads are NOT -- they travel as binary
 * frames (see packages/schema/src/wire.ts) because 2304 tiles x 8 lanes of JSON
 * per sector would dominate both bandwidth and parse time.
 */

export const presenceSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  avatarUrl: z.string().url().nullable(),
  /** stable per-user highlight colour, assigned on join */
  colour: z.string().regex(/^#[0-9a-f]{6}$/i),
  camera: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      yaw: z.number(),
      pitch: z.number()
    })
    .nullable(),
  activeTool: z.string().nullable(),
  selectedSector: sectorCoordSchema.nullable()
});
export type Presence = z.infer<typeof presenceSchema>;

/** client -> server */
export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('join'), projectId: z.string().uuid() }),
  z.object({ t: z.literal('leave') }),

  z.object({ t: z.literal('lock.claim'), sector: sectorCoordSchema }),
  z.object({ t: z.literal('lock.release'), sector: sectorCoordSchema }),
  z.object({ t: z.literal('lock.heartbeat'), sector: sectorCoordSchema }),

  /** request sector payloads; server replies with binary frames */
  z.object({ t: z.literal('sector.subscribe'), sectors: z.array(sectorCoordSchema).max(128) }),
  z.object({ t: z.literal('sector.unsubscribe'), sectors: z.array(sectorCoordSchema).max(128) }),

  z.object({ t: z.literal('op.submit'), ops: z.array(opSchema).min(1).max(64) }),
  z.object({ t: z.literal('op.undo') }),
  z.object({ t: z.literal('op.redo') }),

  z.object({ t: z.literal('presence.update'), presence: presenceSchema.partial().omit({ userId: true }) })
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const lockSchema = z.object({
  sector: sectorCoordSchema,
  userId: z.string().uuid(),
  displayName: z.string(),
  expiresAt: z.string().datetime()
});
export type Lock = z.infer<typeof lockSchema>;

/** server -> client */
export const serverMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('joined'),
    projectId: z.string().uuid(),
    you: presenceSchema,
    peers: z.array(presenceSchema),
    locks: z.array(lockSchema),
    /** latest sequenced op, so the client knows how far behind it is */
    headSeq: z.number().int().nonnegative()
  }),

  z.object({ t: z.literal('peer.join'), presence: presenceSchema }),
  z.object({ t: z.literal('peer.leave'), userId: z.string().uuid() }),
  z.object({ t: z.literal('peer.update'), presence: presenceSchema }),

  z.object({ t: z.literal('lock.granted'), lock: lockSchema }),
  z.object({
    t: z.literal('lock.denied'),
    sector: sectorCoordSchema,
    heldBy: z.string(),
    reason: z.enum(['held', 'forbidden', 'not-a-member'])
  }),
  z.object({ t: z.literal('lock.released'), sector: sectorCoordSchema }),

  /** ops applied and sequenced -- broadcast to everyone in the project */
  z.object({ t: z.literal('op.applied'), ops: z.array(sequencedOpSchema) }),
  z.object({
    t: z.literal('op.rejected'),
    /** the client-generated op ids that did not apply */
    ids: z.array(z.string().uuid()),
    reason: z.enum(['no-lock', 'stale', 'invalid', 'out-of-bounds'])
  }),

  z.object({ t: z.literal('error'), message: z.string() })
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
