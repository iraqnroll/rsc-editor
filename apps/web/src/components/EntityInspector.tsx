/**
 * NPC spawns, ground items and server doors, in the inspector.
 *
 * "On this tile" follows the pointer and is read-only (the pointer leaves the
 * viewport to reach it). Editing goes through the selection: clicking an
 * entity with its tool, or with Select, pins it here until it is deselected.
 * Each committed field is one `entity.update` op, under the sector's lock like
 * any other edit.
 */

import { useEffect, useId, useState } from 'react';
import { DOOR_DIRECTIONS, entityGamePosition, sectorKey } from '@rsc-editor/schema';
import type { EntityData, RscConfig } from '@rsc-editor/schema';
import { useEditor } from '../state/editorStore.js';
import {
  buildEntityRemove,
  buildEntityUpdate,
  entitiesAt,
  findEntity,
  type EntityRef
} from '../ops/entities.js';
import { Readout, Section, Segmented } from './controls.js';

export function EntitiesOnTile() {
  const hoverTile = useEditor((s) => s.hoverTile);
  const entities = useEditor((s) => s.entities);
  const config = useEditor((s) => s.config);
  if (!hoverTile) return null;
  const here = entitiesAt(entities, hoverTile);
  if (here.length === 0) return null;
  return (
    <Section title="On this tile">
      {here.map((ref) => (
        <Readout key={ref.id} label={ref.data.kind} value={describeEntity(ref.data, config)} />
      ))}
      <p className="hint">Click one with the Select, NPC, Item or door tool to edit it.</p>
    </Section>
  );
}

export function SelectedEntity() {
  const selected = useEditor((s) => s.selectedEntity);
  const entities = useEditor((s) => s.entities);
  const config = useEditor((s) => s.config);
  const commit = useEditor((s) => s.commit);
  const selectEntity = useEditor((s) => s.selectEntity);
  if (!selected) return null;
  const ref = findEntity(entities, selected.sector, selected.id);
  if (!ref) return null;

  const at = entityGamePosition(ref.sector, ref.data.i);
  const update = (to: EntityData) => commit(buildEntityUpdate(ref, to), `Edit ${ref.data.kind}`);

  return (
    <Section title={`Selected ${ref.data.kind}`}>
      <Readout label="Sector" value={sectorKey(ref.sector)} />
      <Readout label="Game position" value={`${at.x}, ${at.y}`} />
      <Readout label="What" value={describeEntity(ref.data, config)} />
      <EntityFields entity={ref} update={update} />
      <div className="field__row">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => commit(buildEntityRemove([ref]), `Remove ${ref.data.kind}`)}
        >
          Delete
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => selectEntity(null)}>
          Deselect
        </button>
      </div>
    </Section>
  );
}

function EntityFields({ entity, update }: { entity: EntityRef; update: (to: EntityData) => void }) {
  const data = entity.data;
  const int = (n: number, min = 0) => Math.max(min, Math.floor(n));
  switch (data.kind) {
    case 'npc': {
      const box = data.wander;
      // The box is kept valid while typing: a min past its max drags the max.
      const setBox = (patch: Partial<typeof box>) => {
        const next = { ...box, ...patch };
        if (patch.minX !== undefined) next.maxX = Math.max(next.maxX, next.minX);
        if (patch.maxX !== undefined) next.minX = Math.min(next.minX, next.maxX);
        if (patch.minY !== undefined) next.maxY = Math.max(next.maxY, next.minY);
        if (patch.maxY !== undefined) next.minY = Math.min(next.minY, next.maxY);
        update({ ...data, wander: next });
      };
      return (
        <>
          <CommitNumber label="NPC id" value={data.npcId} min={0} onChange={(n) => update({ ...data, npcId: int(n) })} />
          <CommitNumber label="Wander min x" value={box.minX} min={0} onChange={(n) => setBox({ minX: int(n) })} />
          <CommitNumber label="Wander max x" value={box.maxX} min={0} onChange={(n) => setBox({ maxX: int(n) })} />
          <CommitNumber label="Wander min y" value={box.minY} min={0} onChange={(n) => setBox({ minY: int(n) })} />
          <CommitNumber label="Wander max y" value={box.maxY} min={0} onChange={(n) => setBox({ maxY: int(n) })} />
          <p className="hint">The wander box is drawn in the viewport while the NPC is selected.</p>
        </>
      );
    }
    case 'item':
      return (
        <>
          <CommitNumber label="Item id" value={data.itemId} min={0} onChange={(n) => update({ ...data, itemId: int(n) })} />
          <CommitNumber label="Amount" value={data.amount} min={1} onChange={(n) => update({ ...data, amount: int(n, 1) })} />
          <CommitNumber
            label="Respawn (seconds)"
            value={Math.round(data.respawnMs / 1000)}
            min={0}
            onChange={(n) => update({ ...data, respawnMs: int(n) * 1000 })}
          />
        </>
      );
    case 'door':
      return (
        <>
          <CommitNumber label="Wall id" value={data.wallId} min={0} onChange={(n) => update({ ...data, wallId: int(n) })} />
          <Segmented
            label="Edge"
            value={DOOR_DIRECTIONS[data.direction] ?? 'horizontal'}
            options={DOOR_DIRECTIONS}
            onChange={(edge) => update({ ...data, direction: DOOR_DIRECTIONS.indexOf(edge) })}
          />
        </>
      );
  }
}

export function describeEntity(data: EntityData, config: RscConfig | null): string {
  switch (data.kind) {
    case 'npc':
      return `#${data.npcId} ${config?.npcs[data.npcId]?.name ?? '(undefined)'}`;
    case 'item': {
      const name = config?.items[data.itemId]?.name ?? '(undefined)';
      const amount = data.amount === 1 ? '' : ` x${data.amount}`;
      return `#${data.itemId} ${name}${amount}, respawn ${Math.round(data.respawnMs / 1000)}s`;
    }
    case 'door':
      return `#${data.wallId} ${config?.wallObjects[data.wallId]?.name ?? '(undefined)'}, ${DOOR_DIRECTIONS[data.direction]}`;
  }
}

/**
 * A number input that commits on Enter or blur, not per keystroke. Each commit
 * is an op in everyone's history; typing "120" should be one edit, and an
 * empty field on the way there must not become 0 and drag the box with it.
 */
function CommitNumber({
  label,
  value,
  min,
  onChange
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (next: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  // A peer's edit (or undo) replaces the draft unless the field is mid-edit.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const next = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(next)) {
      setDraft(String(value));
      return;
    }
    if (next !== value) onChange(next);
  };

  return (
    <div className="field">
      <div className="field__label">
        <label htmlFor={id}>{label}</label>
      </div>
      <input
        id={id}
        type="number"
        value={draft}
        min={min}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(String(value));
            setEditing(false);
          }
        }}
      />
    </div>
  );
}
