/**
 * Definition editor: kind picker -> searchable index -> generated form.
 *
 * The kind list is `Object.keys(definitionSchemas)`, not a hand-written array,
 * so all ten kinds are here and an eleventh would appear on its own.
 *
 * Saving emits a `definition.update` op carrying only the fields that actually
 * changed, with their previous values, so `invert()` undoes exactly that edit
 * and nothing else.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { definitionSchemas } from '@rsc-editor/schema';
import type { DefinitionKind } from '@rsc-editor/schema';
import { useEditor } from '../state/editorStore.js';
import { ColourSwatch } from './ColourField.js';
import { DefinitionPreview } from './DefinitionPreview.js';
import { EntitySprite } from './EntitySprite.js';
import { SchemaForm } from './SchemaForm.js';
import { introspectObject } from './zod-introspect.js';

const KINDS = Object.keys(definitionSchemas) as DefinitionKind[];

const ROW_HEIGHT = 22;
const OVERSCAN = 8;

export function DefinitionEditor() {
  const config = useEditor((s) => s.config);
  const commitDefinitionEdit = useEditor((s) => s.commitDefinitionEdit);

  const [kind, setKind] = useState<DefinitionKind>('items');
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);

  const list = useMemo(() => {
    if (!config) return [] as Array<Record<string, unknown>>;
    const lists = config as unknown as Record<string, Array<Record<string, unknown>>>;
    return lists[kind] ?? [];
  }, [config, kind]);

  const fields = useMemo(() => introspectObject(definitionSchemas[kind]), [kind]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = list.map((entry, i) => ({ i, entry }));
    if (!q) return rows;
    // Index search first: "581" should find object 581 even though its name is
    // "null" -- that 0x0-footprint object is one people go looking for.
    const asIndex = Number(q);
    return rows.filter(
      ({ i, entry }) =>
        i === asIndex ||
        String(entry.name ?? '').toLowerCase().includes(q) ||
        String(entry.description ?? '').toLowerCase().includes(q)
    );
  }, [list, query]);

  const selected = list[index];

  // A pending draft belongs to one (kind, index); switching either discards it.
  useEffect(() => {
    setDraft(null);
  }, [kind, index]);

  const changed = useMemo(() => {
    if (!draft || !selected) return {} as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draft)) {
      if (JSON.stringify(v) !== JSON.stringify(selected[k])) out[k] = v;
    }
    return out;
  }, [draft, selected]);

  const dirtyKeys = Object.keys(changed);

  function save(): void {
    if (!selected || dirtyKeys.length === 0) return;
    const from: Record<string, unknown> = {};
    for (const k of dirtyKeys) from[k] = selected[k];
    commitDefinitionEdit(kind, index, from, changed);
    setDraft(null);
  }

  if (!config) {
    return <div className="empty">Loading definitions…</div>;
  }

  const value = draft ?? selected ?? {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="tabs" role="tablist" aria-label="Definition kind">
        {KINDS.map((k) => {
          const lists = config as unknown as Record<string, unknown[]>;
          return (
            <button
              key={k}
              role="tab"
              aria-selected={k === kind}
              onClick={() => {
                setKind(k);
                setIndex(0);
              }}
            >
              {k} <span style={{ opacity: 0.55 }}>{lists[k]?.length ?? 0}</span>
            </button>
          );
        })}
      </div>

      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--line)' }}>
        <input
          type="search"
          value={query}
          placeholder={`Search ${kind} by name or index…`}
          aria-label={`Search ${kind}`}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <VirtualList
        rows={filtered}
        kind={kind}
        selectedIndex={index}
        onSelect={setIndex}
      />

      <div className="panel__header">
        {kind} #{index}
        <span className="spacer" />
        {dirtyKeys.length > 0 && <span style={{ color: 'var(--warn)' }}>{dirtyKeys.length} changed</span>}
      </div>

      <div className="pane__scroll">
        {selected ? (
          <div className="defform">
            {/* What this definition actually is: the item's sprite, the
                object's model BY NAME, the wall's two fills. Drawn from the
                draft, so an edit is reflected before it is saved. */}
            <DefinitionPreview kind={kind} index={index} entry={value} config={config} />
            <SchemaForm
              fields={fields}
              value={value}
              onChange={(field, next) => setDraft({ ...(draft ?? selected), [field]: next })}
            />
            {dirtyKeys.length > 0 && (
              <div className="defform__dirty">
                <span className="hint" style={{ flex: 1 }}>
                  {dirtyKeys.join(', ')}
                </span>
                <button type="button" className="btn btn--sm" onClick={() => setDraft(null)}>
                  Revert
                </button>
                <button type="button" className="btn btn--sm btn--primary" onClick={save}>
                  Save as op
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="empty">No definition at index {index}.</div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- virtual list -- */

function VirtualList({
  rows,
  kind,
  selectedIndex,
  onSelect
}: {
  rows: Array<{ i: number; entry: Record<string, unknown> }>;
  kind: DefinitionKind;
  selectedIndex: number;
  onSelect: (i: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(180);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
  const slice = rows.slice(first, first + visible);

  return (
    <div
      ref={ref}
      className="pane__scroll"
      style={{ flex: '0 0 200px', borderBottom: '1px solid var(--line)' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      role="listbox"
      aria-label={`${kind} list`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const at = rows.findIndex((r) => r.i === selectedIndex);
          const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
          if (next) onSelect(next.i);
        }
      }}
    >
      <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
        <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
          {slice.map(({ i, entry }) => (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected={i === selectedIndex}
              className="row"
              style={{ height: ROW_HEIGHT }}
              onClick={() => onSelect(i)}
            >
              <span className="row__idx">{i}</span>
              {/* The item list is the one place an icon pays for itself: 1290
                  rows of names is a spreadsheet, 1290 rows of icons is a cache
                  browser. `items.sprite` is the index; nothing is guessed. */}
              {kind === 'items' && (
                <EntitySprite
                  plain
                  spriteId={typeof entry.sprite === 'number' ? entry.sprite : null}
                  size={20}
                  label={String(entry.name ?? `#${i}`)}
                />
              )}
              {'colour' in entry && <ColourSwatch value={asColour(entry.colour)} />}
              {'colourFront' in entry && <ColourSwatch value={asColour(entry.colourFront)} />}
              <span className="row__name">{label(entry, i)}</span>
              {entry.members === true && <span className="row__tag">mem</span>}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 && <div className="empty">No matches.</div>}
    </div>
  );
}

function asColour(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function label(entry: Record<string, unknown>, i: number): string {
  const name = entry.name;
  if (typeof name === 'string' && name.length > 0) return name;
  // roofs and tiles have no name field at all
  const bits: string[] = [];
  for (const k of ['type', 'height', 'texture', 'level', 'drain']) {
    if (entry[k] !== undefined && entry[k] !== null) bits.push(`${k} ${String(entry[k])}`);
  }
  return bits.length > 0 ? bits.join(', ') : `#${i}`;
}
