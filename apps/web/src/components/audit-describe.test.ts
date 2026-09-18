import { describe, expect, it } from 'vitest';
import { describeEvent } from './AuditPanels.js';
import type { GameEvent } from '../data/worlds.js';

const ev = (type: string, details: Record<string, unknown>, other: string | null = null): GameEvent => ({
  id: 1,
  worldId: 'main',
  seq: 1,
  at: '2026-09-18T12:00:00Z',
  type,
  player: 'bob',
  other,
  details
});

describe('describeEvent', () => {
  it('says what happened in one line', () => {
    expect(describeEvent(ev('login', { ip: '203.0.113.7', x: 120, y: 648 }))).toBe('logged in from 203.0.113.7 at 120, 648');
    expect(describeEvent(ev('pm', { message: 'hi' }, 'alice'))).toBe('to alice: "hi"');
    expect(describeEvent(ev('pickup', { amount: 5, name: 'Coins', x: 1, y: 2 }, 'carol'))).toBe(
      'picked up 5 x Coins dropped by carol at 1, 2'
    );
    expect(describeEvent(ev('death', { killerIsPlayer: false, dropped: [{ id: 1 }, { id: 2 }] }, 'Goblin'))).toBe(
      'killed by Goblin, dropped 2 item(s)'
    );
    expect(describeEvent(ev('command', { command: 'give', args: ['bob', 'coins'], ran: false, reason: 'rank' }))).toBe(
      '::give bob coins — refused (rank)'
    );
    expect(describeEvent(ev('admin', { action: 'kick' }, 'mallory'))).toBe('kick mallory');
  });
});
