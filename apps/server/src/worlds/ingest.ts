import { lastGameEventSeq, storeGameEvents, type Database, type GameEventInput } from '@rsc-editor/db';
import type { WorldLink } from './link.js';

/**
 * Collects a world's game events into Postgres (`game_events`).
 *
 * The world keeps every event in a spool file until told it is stored
 * (rsc-server/src/admin/events.js). This side always reads in order from
 * what Postgres already has -- `eventsSince(last stored)` -- stores, then
 * acknowledges up to what it stored. A live event from the world is only a
 * nudge to do that sooner. So nothing is skipped, and a crash between
 * storing and acknowledging just means the world sends a few again, which
 * the (world, seq) unique index ignores.
 */

const BATCH = 1000;
const NUDGE_DELAY_MS = 300;
const POLL_MS = 15_000;

export class EventIngest {
  private running = false;
  private again = false;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  /** for the Worlds screen: when events last came in, and any trouble */
  lastSync: Date | null = null;
  lastError: string | null = null;
  stored = 0;

  constructor(
    private readonly link: WorldLink,
    private readonly db: Database,
    private readonly log: { error: (obj: unknown, msg: string) => void }
  ) {}

  start(): void {
    this.link.onUp(() => this.nudge());
    this.pollTimer = setInterval(() => this.nudge(), POLL_MS);
  }

  /** Sync soon; many nudges in a burst of chat become one sync. */
  nudge(): void {
    if (this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.sync();
    }, NUDGE_DELAY_MS);
  }

  async sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.drain();
      } while (this.again);
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
      // A world that is down is normal (the link retries); anything else is not.
      if (this.link.up) this.log.error({ err, world: this.link.config.id }, 'game event sync failed');
    } finally {
      this.running = false;
    }
  }

  private async drain(): Promise<void> {
    if (!this.link.up) return;
    const world = this.link.config.id;
    let last = await lastGameEventSeq(this.db, world);
    // Anything at or below `last` is stored already: tell the world, in case
    // an earlier sync stored and then lost the connection before acking.
    if (last > 0) await this.link.request('ackEvents', { seq: last });
    for (;;) {
      const { events } = await this.link.request<{ events: GameEventInput[] }>('eventsSince', {
        seq: last,
        limit: BATCH
      });
      if (events.length === 0) break;
      this.stored += await storeGameEvents(this.db, world, events);
      last = events[events.length - 1]!.seq;
      await this.link.request('ackEvents', { seq: last });
      this.lastSync = new Date();
      if (events.length < BATCH) break;
    }
  }

  stop(): void {
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}
