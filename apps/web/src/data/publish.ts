/**
 * Publish: the open project onto this install's game server (apps/server
 * `routes/publish.ts`, deploy/game). Live backend only -- the mock has no
 * game to publish to, and `/api/publish` answers `enabled: false` wherever
 * the server was not given a PUBLISH_DIR.
 */

import { getApi } from './api.js';
import { API_BASE, apiJson } from './http.js';

export interface PublishRequest {
  id: string;
  project: string;
  requestedBy: string;
  requestedAt: string;
}

export interface PublishStatus {
  id: string;
  state: 'running' | 'done' | 'failed';
  project?: string;
  requestedBy?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface PublishInfo {
  /** this user may publish, and there is a game to publish to */
  enabled: boolean;
  /** where players open the game; shown to everyone */
  gameUrl: string | null;
  queued: PublishRequest | null;
  status: PublishStatus | null;
}

export function publishInfo(): Promise<PublishInfo> {
  return apiJson<PublishInfo>('/api/publish');
}

export type PublishOutcome = { ok: true; queued: PublishRequest } | { ok: false; problems: string[] };

export async function publishProject(): Promise<PublishOutcome> {
  // The project routes all hang off the same prefix as the library's.
  const project = getApi().libraryPath()?.replace(/\/library$/, '');
  if (!project) return { ok: false, problems: ['no project is open'] };
  const response = await fetch(`${API_BASE}${project}/publish`, {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' }
  });
  const body = (await response.json().catch(() => ({}))) as {
    queued?: PublishRequest;
    problems?: string[];
    message?: string;
  };
  if (response.ok && body.queued) return { ok: true, queued: body.queued };
  // A 422 is the export gate's refusal, with every problem it found; anything
  // else (busy, not an admin) is one message.
  return { ok: false, problems: body.problems ?? [body.message ?? `${response.status} ${response.statusText}`] };
}
