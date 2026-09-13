/**
 * Picks a definition index for a tool (which wall, which scenery object, which
 * roof). Searchable because the cache has 1189 objects and 214 wall objects and
 * scrolling a flat list to find "gate" is not a workflow.
 *
 * The thumbnail slot is a seam: `ModelThumbnail` is a placeholder today and
 * becomes a live .ob3 render once packages/render exposes a model builder.
 */

import { useMemo, useState } from 'react';
import type { DefinitionKind } from '@rsc-editor/schema';
import { useEditor } from '../state/editorStore.js';
import { ColourSwatch } from '../defs/ColourField.js';
import { DefinitionPreview } from '../defs/DefinitionPreview.js';

export interface DefPickerProps {
  kind: DefinitionKind;
  value: number;
  onChange: (index: number) => void;
  label: string;
  /** Show the model preview slot (objects and wall objects only). */
  preview?: boolean;
}

const MAX_ROWS = 200;

export function DefPicker({ kind, value, onChange, label, preview }: DefPickerProps) {
  const config = useEditor((s) => s.config);
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    if (!config) return [] as Array<Record<string, unknown>>;
    const lists = config as unknown as Record<string, Array<Record<string, unknown>>>;
    return lists[kind] ?? [];
  }, [config, kind]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = list.map((entry, i) => ({ i, entry }));
    const matched = q
      ? all.filter(
          ({ i, entry }) => i === Number(q) || String(entry.name ?? '').toLowerCase().includes(q)
        )
      : all;
    return matched.slice(0, MAX_ROWS);
  }, [list, query]);

  const selected = list[value];

  return (
    <div className="field">
      <div className="field__label">
        <span>{label}</span>
        <span className="meta">#{value}</span>
      </div>

      {/* The same header the definition editor uses, so a wall shows its two
          fills and an object shows its model by NAME (never model.id — it is
          wrong for 409 of 1189 objects, DECISIONS §8). */}
      {preview && selected && (
        <DefinitionPreview kind={kind} index={value} entry={selected} config={config} />
      )}

      <input
        type="search"
        value={query}
        placeholder={`Search ${kind}…`}
        aria-label={`Search ${kind}`}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div
        className="list"
        role="listbox"
        aria-label={label}
        style={{ maxHeight: 168, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 4 }}
      >
        {rows.map(({ i, entry }) => (
          <button
            key={i}
            type="button"
            role="option"
            aria-selected={i === value}
            className="row"
            onClick={() => onChange(i)}
          >
            <span className="row__idx">{i}</span>
            {'colourFront' in entry && <ColourSwatch value={asColour(entry.colourFront)} />}
            {'colour' in entry && <ColourSwatch value={asColour(entry.colour)} />}
            <span className="row__name">{String(entry.name ?? `#${i}`)}</span>
            {isZeroFootprint(entry) && (
              <span className="row__tag" title="Width and height are both 0 in the cache">
                0x0
              </span>
            )}
          </button>
        ))}
        {rows.length === 0 && <div className="empty">No matches.</div>}
        {list.length > rows.length && !query && (
          <div className="hint" style={{ padding: '4px 10px' }}>
            showing first {MAX_ROWS} of {list.length} — search to narrow
          </div>
        )}
      </div>
    </div>
  );
}

function asColour(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** objects[581] really is 0x0 in the cache (DECISIONS §6); flag it, don't hide it. */
function isZeroFootprint(entry: Record<string, unknown>): boolean {
  return entry.width === 0 && entry.height === 0;
}

