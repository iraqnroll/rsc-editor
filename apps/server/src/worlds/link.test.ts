import { afterEach, describe, expect, it } from 'vitest';
import { FakeWorld } from './fake-world.js';
import { WorldLink, WorldUnavailable } from './link.js';

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('WorldLink', () => {
  const cleanup: Array<() => unknown> = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0)) await c();
  });

  it('asks and gets the answer to that question', async () => {
    const world = new FakeWorld({ status: () => ({ players: 3 }), kick: ({ username }) => ({ kicked: username }) });
    await world.listen();
    const link = new WorldLink({ id: 'main', name: 'Main', socket: world.path });
    link.start();
    cleanup.push(() => link.close(), () => world.close());
    await until(() => link.up);

    const [status, kicked] = await Promise.all([link.request('status'), link.request('kick', { username: 'bob' })]);
    expect(status).toEqual({ players: 3 });
    expect(kicked).toEqual({ kicked: 'bob' });
  });

  it('passes on a refusal as an error with the world\'s reason', async () => {
    const world = new FakeWorld({
      kick: () => {
        throw new Error('bob is not online');
      }
    });
    await world.listen();
    const link = new WorldLink({ id: 'main', name: 'Main', socket: world.path });
    link.start();
    cleanup.push(() => link.close(), () => world.close());
    await until(() => link.up);
    await expect(link.request('kick', { username: 'bob' })).rejects.toThrow('bob is not online');
  });

  it('reports a world that is not there, then connects when it appears', async () => {
    const world = new FakeWorld({ status: () => ({ players: 0 }) });
    const link = new WorldLink({ id: 'main', name: 'Main', socket: world.path });
    link.start();
    cleanup.push(() => link.close(), () => world.close());

    await expect(link.request('status')).rejects.toBeInstanceOf(WorldUnavailable);
    await world.listen();
    await until(() => link.up, 5000);
    expect(await link.request('status')).toEqual({ players: 0 });
  });

  it('hands events to its listener', async () => {
    const world = new FakeWorld();
    await world.listen();
    const seen: unknown[] = [];
    const link = new WorldLink({ id: 'main', name: 'Main', socket: world.path }, (id, event) => seen.push([id, event]));
    link.start();
    cleanup.push(() => link.close(), () => world.close());
    await until(() => link.up);
    world.event({ type: 'login', player: 'bob' });
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual(['main', { type: 'login', player: 'bob' }]);
  });
});
