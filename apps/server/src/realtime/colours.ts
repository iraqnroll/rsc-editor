/**
 * Presence colours.
 *
 * The colour is derived from the user id rather than handed out round-robin on
 * join, and that is deliberate: a round-robin colour changes every time you
 * reconnect, so "the orange person is editing 50/49" stops meaning anything the
 * moment someone's wifi blips. A hash of the (immutable) user id gives the same
 * person the same tint in every session, on every server instance, forever --
 * which is what makes the read-only sector tint readable at a glance.
 *
 * Collisions are possible with more than `PRESENCE_COLOURS.length` people in one
 * project. That is accepted: the alternative (per-room assignment) reintroduces
 * instability, and the peer list carries the display name anyway.
 */

/**
 * Deliberately picked to stay distinguishable against the terrain palette and
 * from each other. Lower-case hex, because `presenceSchema` matches
 * `/^#[0-9a-f]{6}$/i` and lower-case is what the client's CSS will compare.
 */
export const PRESENCE_COLOURS = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#46f0f0',
  '#f032e6',
  '#bcf60c',
  '#fabebe',
  '#008080',
  '#9a6324',
  '#800000',
  '#aaffc3',
  '#808000',
  '#ffd8b1',
  '#000075'
] as const;

/**
 * FNV-1a, 32-bit. Not a security primitive -- it is here because it is tiny,
 * dependency-free and stable across Node versions (unlike anything built on
 * object iteration order or `Math.random`).
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // imul keeps the multiply in 32-bit space; a plain `*` overflows to a
    // double and silently stops being FNV after ~5 characters.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function colourForUser(userId: string): string {
  return (
    PRESENCE_COLOURS[fnv1a(userId) % PRESENCE_COLOURS.length] ??
    PRESENCE_COLOURS[0]
  );
}
