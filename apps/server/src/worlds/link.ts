import { createConnection, type Socket } from 'node:net';

/**
 * One game world's control socket (rsc-game's `rsc-server/src/admin`).
 *
 * A unix socket speaking one JSON object per line: requests carry an `id`,
 * replies echo it, and lines with `event` are the world talking unasked. The
 * link keeps itself connected -- a world restarting (a publish, a crash) is
 * normal, so it retries with backoff and reports "down" in the meantime
 * rather than failing requests forever.
 */

export interface WorldConfig {
  id: string;
  name: string;
  /** path of the world's control socket */
  socket: string;
}

export type WorldEvent = Record<string, unknown>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 10_000;

export class WorldUnavailable extends Error {
  constructor(world: string, why: string) {
    super(`world ${world} is not reachable: ${why}`);
    this.name = 'WorldUnavailable';
  }
}

export class WorldLink {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private retryMs = RETRY_MIN_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private closed = false;
  /** why the last connection attempt failed, while down */
  lastError: string | null = 'not connected yet';
  up = false;

  private readonly upListeners: Array<() => void> = [];

  constructor(
    readonly config: WorldConfig,
    private readonly onEvent: (world: string, event: WorldEvent) => void = () => {}
  ) {}

  /** Called on every (re)connect, e.g. to catch up on what was missed. */
  onUp(listener: () => void): void {
    this.upListeners.push(listener);
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const socket = createConnection(this.config.socket);
    socket.setEncoding('utf8');
    this.socket = socket;

    socket.on('connect', () => {
      this.up = true;
      this.lastError = null;
      this.retryMs = RETRY_MIN_MS;
      for (const listener of this.upListeners) listener();
    });
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', (err) => {
      this.lastError = err.message;
    });
    socket.on('close', () => {
      this.up = false;
      this.socket = null;
      this.buffer = '';
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new WorldUnavailable(this.config.id, 'the connection closed'));
      }
      this.pending.clear();
      if (!this.closed) {
        this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
      }
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: WorldEvent };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.event) {
        this.onEvent(this.config.id, message.event);
        continue;
      }
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!pending) continue;
      this.pending.delete(message.id!);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? 'the world refused'));
    }
  }

  request<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.up) {
      return Promise.reject(new WorldUnavailable(this.config.id, this.lastError ?? 'not connected'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorldUnavailable(this.config.id, `${cmd} got no answer in ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      socket.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket?.destroy();
  }
}
