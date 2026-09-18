import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for rsc-server's control socket, for tests: answers each
 * command from `handlers`, and can push events and drop connections.
 */
export class FakeWorld {
  readonly dir = mkdtempSync(join(tmpdir(), 'rsc-world-'));
  readonly path = join(this.dir, 'world.sock');
  readonly received: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  private server: Server | null = null;
  private readonly conns = new Set<Socket>();

  constructor(
    readonly handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}
  ) {}

  listen(): Promise<void> {
    this.server = createServer((conn) => {
      this.conns.add(conn);
      conn.setEncoding('utf8');
      let buffer = '';
      conn.on('data', (chunk: string) => {
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          const { id, cmd, args } = JSON.parse(line) as { id: number; cmd: string; args: Record<string, unknown> };
          this.received.push({ cmd, args });
          const handler = this.handlers[cmd];
          try {
            if (!handler) throw new Error(`unknown command ${cmd}`);
            conn.write(`${JSON.stringify({ id, ok: true, result: handler(args) })}\n`);
          } catch (err) {
            conn.write(`${JSON.stringify({ id, ok: false, error: (err as Error).message })}\n`);
          }
        }
      });
      conn.on('close', () => this.conns.delete(conn));
    });
    return new Promise((resolve) => this.server!.listen(this.path, resolve));
  }

  event(event: Record<string, unknown>): void {
    for (const conn of this.conns) conn.write(`${JSON.stringify({ event })}\n`);
  }

  async close(): Promise<void> {
    for (const conn of this.conns) conn.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}
