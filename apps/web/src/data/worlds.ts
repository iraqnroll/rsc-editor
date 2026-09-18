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

export function listWorlds(): Promise<{ worlds: WorldSummary[]; configError: string | null }> {
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
