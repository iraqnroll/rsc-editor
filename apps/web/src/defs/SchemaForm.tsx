/**
 * The generated definition form.
 *
 * Every control here is chosen from a `FieldNode`, never from a field name, so
 * all ten definition kinds share one renderer and a schema change shows up in
 * the UI without anyone editing this file.
 *
 * The two behaviours that exist because the real cache demanded them:
 *   - a null field renders the word "none" plus a "set" affordance, not an
 *     empty input that looks broken (items.equip is null 949/1290 times);
 *   - `colour` is its own node kind so `transparent` round-trips (DECISIONS §6).
 */

import { useState } from 'react';
import { ColourField } from './ColourField.js';
import { defaultForNode, describeNode, type FieldNode } from './zod-introspect.js';

export interface SchemaFormProps {
  fields: Array<{ name: string; node: FieldNode }>;
  value: Record<string, unknown>;
  onChange: (field: string, next: unknown) => void;
  disabled?: boolean;
}

export function SchemaForm({ fields, value, onChange, disabled }: SchemaFormProps) {
  return (
    <>
      {fields.map((f) => (
        <NodeControl
          key={f.name}
          label={humanise(f.name)}
          node={f.node}
          value={value[f.name]}
          onChange={(next) => onChange(f.name, next)}
          disabled={disabled}
        />
      ))}
    </>
  );
}

/* ------------------------------------------------------------- dispatch -- */

interface ControlProps {
  label: string;
  node: FieldNode;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  /** Suppresses the label row for nested array elements. */
  bare?: boolean;
}

export function NodeControl(props: ControlProps) {
  const { label, node, value, onChange, disabled, bare } = props;

  // Colour is handled before nullable so the "none" state lives inside the
  // colour control, next to "transparent" — the two are easy to confuse and
  // putting them in one segmented control makes the difference explicit.
  if (node.kind === 'colour') {
    return (
      <Labelled label={label} node={node} bare={bare}>
        <ColourField
          value={typeof value === 'string' ? value : null}
          nullable={false}
          disabled={disabled}
          onChange={onChange}
        />
      </Labelled>
    );
  }
  if (node.kind === 'nullable' && node.inner.kind === 'colour') {
    return (
      <Labelled label={label} node={node} bare={bare}>
        <ColourField
          value={typeof value === 'string' ? value : null}
          nullable
          disabled={disabled}
          onChange={onChange}
        />
      </Labelled>
    );
  }

  if (node.kind === 'nullable' || node.kind === 'optional') {
    return (
      <Labelled label={label} node={node} bare={bare}>
        <NullableControl
          inner={node.inner}
          value={value}
          onChange={onChange}
          disabled={disabled}
          label={label}
        />
      </Labelled>
    );
  }

  return (
    <Labelled label={label} node={node} bare={bare}>
      <ConcreteControl node={node} value={value} onChange={onChange} disabled={disabled} label={label} />
    </Labelled>
  );
}

function Labelled({
  label,
  node,
  bare,
  children
}: {
  label: string;
  node: FieldNode;
  bare?: boolean;
  children: React.ReactNode;
}) {
  if (bare) return <>{children}</>;
  return (
    <div className="field">
      <div className="field__label">
        <span>{label}</span>
        <span className="meta">{describeNode(node)}</span>
      </div>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------- nullable -- */

function NullableControl({
  inner,
  value,
  onChange,
  disabled,
  label
}: {
  inner: FieldNode;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  label: string;
}) {
  const isNull = value === null || value === undefined;

  if (isNull) {
    return (
      <div className="nullable">
        <span className="nullable__none">none</span>
        <button
          type="button"
          className="btn btn--sm"
          disabled={disabled}
          onClick={() => onChange(defaultForNode(inner))}
        >
          set
        </button>
      </div>
    );
  }

  return (
    <div className="nullable">
      <div style={{ flex: 1, minWidth: 0 }}>
        <ConcreteControl node={inner} value={value} onChange={onChange} disabled={disabled} label={label} />
      </div>
      <button
        type="button"
        className="btn btn--sm btn--ghost btn--danger"
        disabled={disabled}
        title="Set to null"
        onClick={() => onChange(null)}
      >
        clear
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- concrete -- */

function ConcreteControl({
  node,
  value,
  onChange,
  disabled,
  label
}: {
  node: FieldNode;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  label: string;
}) {
  switch (node.kind) {
    case 'boolean':
      return (
        <label className="check">
          <input
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{value === true ? 'true' : 'false'}</span>
        </label>
      );

    case 'number':
      return (
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          step={node.int ? 1 : 'any'}
          min={node.min ?? undefined}
          max={node.max ?? undefined}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return;
            const n = Number(raw);
            onChange(node.int ? Math.round(n) : n);
          }}
        />
      );

    case 'string': {
      const text = typeof value === 'string' ? value : '';
      const multiline = text.length > 64;
      return multiline ? (
        <textarea
          value={text}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="text"
          value={text}
          disabled={disabled}
          aria-label={label}
          placeholder={node.pattern ? node.pattern : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }

    case 'enum':
      return (
        <select
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        >
          {node.values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );

    case 'literal':
      return <input type="text" value={String(node.value)} disabled readOnly aria-label={label} />;

    case 'colour':
      return (
        <ColourField
          value={typeof value === 'string' ? value : null}
          nullable={false}
          disabled={disabled}
          onChange={onChange}
        />
      );

    case 'array':
      return <ArrayControl node={node} value={value} onChange={onChange} disabled={disabled} label={label} />;

    case 'object': {
      const obj = (value ?? {}) as Record<string, unknown>;
      return (
        <div className="subform">
          {node.fields.map((f) => (
            <NodeControl
              key={f.name}
              label={humanise(f.name)}
              node={f.node}
              value={obj[f.name]}
              disabled={disabled}
              onChange={(next) => onChange({ ...obj, [f.name]: next })}
            />
          ))}
        </div>
      );
    }

    case 'union':
    case 'unknown':
      return <JsonControl value={value} onChange={onChange} disabled={disabled} label={label} />;
  }
}

/* ----------------------------------------------------------------- array -- */

function ArrayControl({
  node,
  value,
  onChange,
  disabled,
  label
}: {
  node: Extract<FieldNode, { kind: 'array' }>;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  label: string;
}) {
  const items: unknown[] = Array.isArray(value) ? value : [];

  // An array of a single enum reads far better as a chip group than as N
  // selects — items.equip ("body", "legs") is the case that matters.
  if (node.element.kind === 'enum' && node.exactLength === null) {
    const selected = new Set(items.filter((v): v is string => typeof v === 'string'));
    return (
      <div className="chips" role="group" aria-label={label}>
        {node.element.values.map((v) => (
          <button
            key={v}
            type="button"
            className="chip"
            aria-pressed={selected.has(v)}
            disabled={disabled}
            onClick={() => {
              const next = new Set(selected);
              if (next.has(v)) next.delete(v);
              else next.add(v);
              onChange(node.element.kind === 'enum' ? node.element.values.filter((x) => next.has(x)) : []);
            }}
          >
            {v}
          </button>
        ))}
      </div>
    );
  }

  const fixed = node.exactLength !== null;
  const rows = fixed ? Math.max(node.exactLength ?? 0, items.length) : items.length;

  return (
    <div className="subform">
      {rows === 0 && <div className="hint">empty</div>}
      {Array.from({ length: rows }, (_, i) => (
        <div className="arrayitem" key={i}>
          <span className="arrayitem__i">{i}</span>
          <div className="arrayitem__body">
            <NodeControl
              bare
              label={`${label} ${i}`}
              node={node.element}
              value={items[i]}
              disabled={disabled}
              onChange={(next) => {
                const copy = items.slice();
                copy[i] = next;
                onChange(copy);
              }}
            />
          </div>
          {!fixed && (
            <button
              type="button"
              className="btn btn--sm btn--ghost btn--danger"
              disabled={disabled}
              aria-label={`Remove item ${i}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              &times;
            </button>
          )}
        </div>
      ))}
      {!fixed && (
        <button
          type="button"
          className="btn btn--sm"
          disabled={disabled}
          onClick={() => onChange([...items, defaultForNode(node.element)])}
        >
          + add
        </button>
      )}
      {fixed && (
        <div className="hint">
          Fixed length {node.exactLength} — slots cannot be added or removed.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ json -- */

function JsonControl({
  value,
  onChange,
  disabled,
  label
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  label: string;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null));
  const [bad, setBad] = useState(false);
  return (
    <div className="field">
      <textarea
        value={text}
        disabled={disabled}
        aria-label={label}
        aria-invalid={bad}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <span className="hint">not valid JSON — not saved</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ util -- */

export function humanise(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}
