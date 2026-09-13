/**
 * The parts of the realtime layer that are pure.
 *
 * Everything that needs two sockets and a real sequencer lives in
 * `integration.test.ts`; this file covers the decisions that are worth pinning
 * down without a database -- colour stability, what a presence patch is allowed
 * to touch, and the delta validator that stands between a client's claims and
 * the op log.
 */

import { describe, expect, it } from 'vitest';
import {
  SECTOR_FRAME_BYTES,
  decodeSectorFrame,
  emptySectorBuffers,
  encodeSectorFrame,
  presenceSchema,
  type Presence
} from '@rsc-editor/schema';
import { PRESENCE_COLOURS, colourForUser } from './colours.js';
import { applyPresencePatch, avatarUrlFor, displayNameFor } from './presence.js';
import { applyDelta, checkDelta, laneRange, openFrame } from './sector-frame.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

/**
 * `Uint8Array.buffer` is `ArrayBufferLike`, which `decodeSectorFrame` will not
 * take. Copying into a fresh, exactly-sized `ArrayBuffer` is what a caller has
 * to do anyway when the source is a pooled `Buffer` from the driver.
 */
function asArrayBuffer(payload: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(payload.byteLength);
  new Uint8Array(out).set(payload);
  return out;
}

describe('presence colours', () => {
  it('gives the same user the same colour every time', () => {
    expect(colourForUser(USER_A)).toBe(colourForUser(USER_A));
  });

  it('only ever emits a colour the protocol accepts', () => {
    const shape = presenceSchema.shape.colour;
    for (let i = 0; i < 200; i++) {
      const colour = colourForUser(`${USER_A}-${i}`);
      expect(shape.safeParse(colour).success).toBe(true);
      expect(PRESENCE_COLOURS).toContain(colour);
    }
  });

  it('spreads users across the palette rather than piling onto one entry', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(colourForUser(`user-${i}`));
    // Not a distribution proof -- a canary for a hash that has collapsed (the
    // `Math.imul` overflow bug makes this drop to a handful).
    expect(seen.size).toBeGreaterThan(PRESENCE_COLOURS.length / 2);
  });
});

describe('display names and avatars', () => {
  it('prefers the Discord global name and falls back to the handle', () => {
    expect(displayNameFor({ username: 'zezima', globalName: 'Zezima' })).toBe(
      'Zezima'
    );
    expect(displayNameFor({ username: 'zezima', globalName: null })).toBe(
      'zezima'
    );
    // a global name of whitespace is not a display name
    expect(displayNameFor({ username: 'zezima', globalName: '  ' })).toBe(
      'zezima'
    );
  });

  it('derives a CDN url from the avatar hash, or null', () => {
    expect(avatarUrlFor({ discordId: '123', avatar: null })).toBeNull();
    const url = avatarUrlFor({ discordId: '123', avatar: 'abc' });
    expect(url).toBe('https://cdn.discordapp.com/avatars/123/abc.png');
    // animated avatars are prefixed a_ and must be requested as gif
    expect(avatarUrlFor({ discordId: '123', avatar: 'a_abc' })).toMatch(/\.gif$/);
    expect(presenceSchema.shape.avatarUrl.safeParse(url).success).toBe(true);
  });
});

describe('presence patches', () => {
  const base: Presence = {
    userId: USER_A,
    displayName: 'Zezima',
    avatarUrl: null,
    colour: '#e6194b',
    camera: null,
    activeTool: null,
    selectedSector: null
  };

  it('applies the volatile fields', () => {
    const next = applyPresencePatch(base, {
      activeTool: 'elevation.raise',
      selectedSector: { plane: 0, x: 50, y: 50 },
      camera: { x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0.1 }
    });
    expect(next.activeTool).toBe('elevation.raise');
    expect(next.selectedSector).toEqual({ plane: 0, x: 50, y: 50 });
    expect(next.camera?.yaw).toBe(0.5);
  });

  it('treats an explicit null as a value, not as "unset"', () => {
    const selected = applyPresencePatch(base, {
      selectedSector: { plane: 0, x: 50, y: 50 }
    });
    expect(applyPresencePatch(selected, { selectedSector: null }).selectedSector)
      .toBeNull();
    // ...and an absent key leaves it alone
    expect(applyPresencePatch(selected, { activeTool: 'x' }).selectedSector)
      .toEqual({ plane: 0, x: 50, y: 50 });
  });

  /**
   * `presenceSchema.partial()` structurally permits these, so the only thing
   * stopping one editor appearing in the peer list as another is this function.
   */
  it('refuses to let a client rewrite its own identity', () => {
    const next = applyPresencePatch(base, {
      displayName: 'Someone Else',
      colour: '#000000',
      avatarUrl: 'https://example.com/evil.png'
    } as Partial<Omit<Presence, 'userId'>>);

    expect(next.displayName).toBe('Zezima');
    expect(next.colour).toBe('#e6194b');
    expect(next.avatarUrl).toBeNull();
    expect(next.userId).toBe(USER_A);
    expect(next.userId).not.toBe(USER_B);
  });
});

describe('sector frames', () => {
  function storedFrame(): Uint8Array {
    const buffers = emptySectorBuffers();
    buffers.elevation[0] = 64;
    buffers.wallsDiagonal[5] = 48_001;
    return new Uint8Array(
      encodeSectorFrame({
        coord: { plane: 0, x: 50, y: 50 },
        members: false,
        buffers
      })
    );
  }

  it('opens a private, correctly aligned copy', () => {
    const stored = storedFrame();
    const open = openFrame(stored);

    expect(open.bytes.byteLength).toBe(SECTOR_FRAME_BYTES);
    expect(open.buffers.elevation[0]).toBe(64);

    applyDelta(open.buffers, { i: 0, lane: 'elevation', from: 64, to: 99 });

    // the view writes through to the frame bytes -- no re-encode step
    expect(
      decodeSectorFrame(asArrayBuffer(open.bytes)).buffers.elevation[0]
    ).toBe(99);
    // ...but the stored payload we were handed is untouched
    expect(decodeSectorFrame(asArrayBuffer(stored)).buffers.elevation[0]).toBe(
      64
    );
  });

  it('rejects a payload that is not a whole frame', () => {
    expect(() => openFrame(new Uint8Array(10))).toThrow(/expected/);
  });

  it('knows which lane is the Int32 one', () => {
    expect(laneRange('elevation')).toEqual({ min: 0, max: 255 });
    expect(laneRange('wallsDiagonal').max).toBeGreaterThan(48_000);
  });

  /**
   * The load-bearing check. `from` is a client assertion about server state; if
   * it is recorded into the op log without being verified, undo later replays a
   * tile to a value it never had.
   */
  it('rejects a delta whose `from` disagrees with the stored byte', () => {
    const { buffers } = openFrame(storedFrame());
    expect(
      checkDelta(buffers, { i: 0, lane: 'elevation', from: 64, to: 70 })
    ).toBeNull();
    expect(
      checkDelta(buffers, { i: 0, lane: 'elevation', from: 63, to: 70 })
    ).toBe('stale');
    expect(
      checkDelta(buffers, { i: 5, lane: 'wallsDiagonal', from: 48_001, to: 0 })
    ).toBeNull();
    expect(
      checkDelta(buffers, { i: 5, lane: 'wallsDiagonal', from: 0, to: 1 })
    ).toBe('stale');
  });

  /**
   * `tileDeltaSchema` is only `z.number().int()`, and seven of the eight lanes
   * are bytes. Writing 300 into a Uint8Array silently stores 44 -- which would
   * disagree with the `to` recorded in the op log and make replay
   * non-deterministic.
   */
  it('rejects a value that does not fit its lane instead of truncating it', () => {
    const { buffers } = openFrame(storedFrame());
    expect(checkDelta(buffers, { i: 1, lane: 'colour', from: 0, to: 300 })).toBe(
      'invalid'
    );
    expect(checkDelta(buffers, { i: 1, lane: 'colour', from: 0, to: -1 })).toBe(
      'invalid'
    );
    // the Int32 lane happily takes a scenery id
    expect(
      checkDelta(buffers, { i: 1, lane: 'wallsDiagonal', from: 0, to: 48_500 })
    ).toBeNull();
  });

  it('rejects a tile index outside the sector', () => {
    const { buffers } = openFrame(storedFrame());
    expect(
      checkDelta(buffers, { i: 2304, lane: 'elevation', from: 0, to: 1 })
    ).toBe('out-of-bounds');
  });
});
