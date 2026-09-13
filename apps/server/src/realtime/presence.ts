/**
 * Presence records.
 *
 * A `Presence` mixes two kinds of field and they are governed differently:
 *
 *   - **identity** (`userId`, `displayName`, `avatarUrl`, `colour`) is derived
 *     from the `users` row at join time and is SERVER OWNED. `presence.update`
 *     carries a `presenceSchema.partial()`, which structurally allows a client
 *     to send a new `displayName` or `colour` -- `applyPresencePatch` drops
 *     those. Otherwise anyone could impersonate another editor in the peer list
 *     or repaint themselves as the person holding the lock next door.
 *
 *   - **volatile** (`camera`, `activeTool`, `selectedSector`) is whatever the
 *     client last said. It is never persisted: it dies with the socket.
 */

import type { Presence, SectorCoord } from '@rsc-editor/schema';
import type { User } from '@rsc-editor/db';
import { colourForUser } from './colours.js';

/** Discord's newer display name wins; the handle is the fallback. */
export function displayNameFor(user: {
  username: string;
  globalName: string | null;
}): string {
  const global = user.globalName?.trim();
  return global && global.length > 0 ? global : user.username;
}

const DISCORD_CDN = 'https://cdn.discordapp.com';

/**
 * `users.avatar` is a *hash*, not a URL (see the db schema). The CDN URL is
 * derived rather than stored so a change to Discord's URL shape is a one-line
 * fix instead of a migration.
 */
export function avatarUrlFor(user: {
  discordId: string;
  avatar: string | null;
}): string | null {
  if (!user.avatar) return null;
  const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
  return `${DISCORD_CDN}/avatars/${user.discordId}/${user.avatar}.${ext}`;
}

export function initialPresence(user: User): Presence {
  return {
    userId: user.id,
    displayName: displayNameFor(user),
    avatarUrl: avatarUrlFor(user),
    colour: colourForUser(user.id),
    camera: null,
    activeTool: null,
    selectedSector: null
  };
}

export type PresencePatch = Partial<Omit<Presence, 'userId'>>;

/**
 * Merge a client patch onto the server's copy, keeping identity fields.
 *
 * `'camera' in patch` rather than `patch.camera !== undefined`, because `null`
 * is a meaningful value here ("I have no camera / I deselected the sector") and
 * has to be distinguishable from "I did not mention this field".
 */
export function applyPresencePatch(
  current: Presence,
  patch: PresencePatch
): Presence {
  const next: Presence = { ...current };
  if ('camera' in patch) next.camera = patch.camera ?? null;
  if ('activeTool' in patch) next.activeTool = patch.activeTool ?? null;
  if ('selectedSector' in patch) {
    next.selectedSector = (patch.selectedSector ?? null) as SectorCoord | null;
  }
  return next;
}
