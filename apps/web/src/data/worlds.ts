/**
 * The game worlds' control API (apps/server `routes/worlds.ts`). Live backend
 * only, and admins only; anyone else gets a 403, which hides the button.
 */

import { apiJson } from './http.js';

export interface WorldStatus {
  worldId: number;
  members: boolean;
  startedAt: string;
  uptimeSeconds: number;
  players: number;
  capacity: number;
  memoryMB: number;
  shutdown: { at: string; reason: string } | null;
}

export interface WorldSummary {
  id: string;
  name: string;
  up: boolean;
  /** why it is down, or what the last request said */
  error: string | null;
  status: WorldStatus | null;
  /** how the editor is doing at collecting this world's events */
  events: { lastSync: string | null; error: string | null } | null;
}

export interface OnlinePlayer {
  username: string;
  rank: number;
  rankName: string;
  x: number;
  y: number;
  combatLevel: number;
  ip: string | null;
  loggedInAt: string | null;
}

const enc = encodeURIComponent;

export function listWorlds(): Promise<{
  worlds: WorldSummary[];
  configError: string | null;
  retentionDays?: Record<string, number>;
}> {
  return apiJson('/api/worlds');
}

export async function worldPlayers(world: string): Promise<OnlinePlayer[]> {
  return (await apiJson<{ result: OnlinePlayer[] }>(`/api/worlds/${enc(world)}/players`)).result;
}

function post(world: string, action: string, body: Record<string, unknown> = {}): Promise<unknown> {
  return apiJson(`/api/worlds/${enc(world)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
}

export const broadcast = (world: string, message: string) => post(world, 'broadcast', { message });
export const kick = (world: string, username: string) => post(world, 'kick', { username });
export const restart = (world: string, seconds: number, reason: string) => post(world, 'restart', { seconds, reason });
export const cancelRestart = (world: string) => post(world, 'cancel-restart');

/* ---------------------------------------------------------------- audit -- */

export interface GameEvent {
  id: number;
  worldId: string;
  seq: number;
  at: string;
  type: string;
  player: string | null;
  other: string | null;
  details: Record<string, unknown>;
}

export interface AdminAction {
  id: number;
  at: string;
  actorName: string;
  action: string;
  worldId: string | null;
  target: string | null;
  details: Record<string, unknown>;
  result: string;
}

export interface EventFilter {
  player?: string;
  types?: string[];
  world?: string;
  text?: string;
  from?: string;
  to?: string;
  before?: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export async function searchEvents(f: EventFilter): Promise<GameEvent[]> {
  const body = await apiJson<{ events: GameEvent[] }>(
    `/api/audit/events${query({ ...f, types: f.types?.join(','), limit: 100 })}`
  );
  return body.events;
}

export async function searchAdminActions(f: { who?: string; action?: string; before?: number }): Promise<AdminAction[]> {
  const body = await apiJson<{ actions: AdminAction[] }>(`/api/audit/admin${query({ ...f, limit: 100 })}`);
  return body.actions;
}
