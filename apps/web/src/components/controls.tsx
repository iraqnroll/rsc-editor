/**
 * The handful of primitives every panel uses. Deliberately unstyled-by-props:
 * appearance lives in styles.css so the whole editor restyles in one place.
 */

import { useId, useState } from 'react';
import type { ReactNode } from 'react';

export function Section({
  title,
  children,
  defaultOpen = true,
  right
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="section">
      <button
        type="button"
        className="section__title"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="section__chevron" data-open={open} aria-hidden="true">
          &#9654;
        </span>
        {title}
        {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
      </button>
      {open && (
        <div className="section__body" id={id}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: ReadonlyArray<T | { value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="field">
      <div className="field__label">
        <span>{label}</span>
      </div>
      <div className="segmented" role="group" aria-label={label}>
        {options.map((opt) => {
          const v = typeof opt === 'string' ? opt : opt.value;
          const text = typeof opt === 'string' ? opt : opt.label;
          return (
            <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>
              {text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (next: number) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="field__label">
        <label htmlFor={id}>{label}</label>
        <span className="meta">
          {step < 1 ? value.toFixed(2) : value}
          {suffix ?? ''}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  hint
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (next: number) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="field__label">
        <label htmlFor={id}>{label}</label>
        {hint && <span className="meta">{hint}</span>}
      </div>
      <input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Readout({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="field__label">
      <span>{label}</span>
      <span className="meta">{value}</span>
    </div>
  );
}
