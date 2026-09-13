/**
 * Applying and describing ops.
 *
 * `applySectorOp` is the ONLY function in the app that writes to a sector
 * lane. Everything else goes through the store, which goes through here. That
 * is what makes undo, the history panel and (later) remote op replay all work
 * off the same code path — a component reaching into a lane directly would be
 * invisible to all three.
 */

import type { Lane, Op, SectorBuffers, SectorOp, TileDelta } from '@rsc-editor/schema';

/** wallsDiagonal is Int32; the other seven lanes are Uint8. */
export function clampLane(lane: Lane, value: number): number {
  if (lane === 'wallsDiagonal') return value | 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function applySectorOp(buffers: SectorBuffers, op: SectorOp): void {
  for (const change of op.changes) {
    buffers[change.lane][change.i] = change.to;
  }
}

/** Only used to verify an op still matches the sector it was built against. */
export function opIsCurrent(buffers: SectorBuffers, op: SectorOp): boolean {
  return op.changes.every((c) => buffers[c.lane][c.i] === c.from);
}

/**
 * Drop no-op deltas. A brush pass over already-flat ground would otherwise
 * push an op that does nothing but still consumes an undo step.
 */
export function pruneDeltas(changes: TileDelta[]): TileDelta[] {
  return changes.filter((c) => c.from !== c.to);
}

const OP_LABELS: Record<string, string> = {
  'elevation.raise': 'Raise terrain',
  'elevation.lower': 'Lower terrain',
  'elevation.smooth': 'Smooth terrain',
  'elevation.flatten': 'Flatten terrain',
  'paint.colour': 'Paint colour',
  'paint.overlay': 'Paint overlay',
  'wall.set': 'Place wall',
  'wall.clear': 'Remove wall',
  'roof.set': 'Set roof',
  'scenery.place': 'Place scenery',
  'scenery.rotate': 'Rotate scenery',
  'scenery.remove': 'Remove scenery',
  'region.fill': 'Fill region',
  'region.paste': 'Paste region',
  'definition.update': 'Edit definition'
};

export function describeOp(op: Op): string {
  const label = OP_LABELS[op.kind] ?? op.kind;
  if (op.type === 'definition') return `${label} (${op.defKind} #${op.index})`;
  return label;
}

export function opTileCount(op: Op): number {
  return op.type === 'sector' ? op.changes.length : Object.keys(op.to).length;
}

/** crypto.randomUUID is not available on insecure origins in every browser. */
export function opId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[8 + Math.floor(Math.random() * 4)];
    else out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
}
