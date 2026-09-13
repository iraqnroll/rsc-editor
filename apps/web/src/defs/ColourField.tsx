/**
 * The colour control.
 *
 * Three states, and all three are real values in the cache:
 *
 *   none         -- the field is nullable and unset (items.colour is null for
 *                   461/1290 items, so this is the common case, not an edge)
 *   transparent  -- a hole punched through the geometry (DECISIONS §6)
 *   rgb(r, g, b) -- an actual colour
 *
 * The original string is passed through untouched unless the user edits the
 * numeric channels, so "rgb(238, 221, 221)" comes back out byte-identical.
 */

import { useId } from 'react';
import {
  TRANSPARENT,
  formatRgb,
  hexToRgb,
  isTransparent,
  parseRgb,
  rgbToHex
} from './colour.js';

export interface ColourFieldProps {
  value: string | null;
  onChange: (next: string | null) => void;
  /** false when the schema does not allow null (e.g. animations.colour). */
  nullable: boolean;
  disabled?: boolean;
}

type Mode = 'none' | 'transparent' | 'rgb';

function modeOf(value: string | null): Mode {
  if (value === null) return 'none';
  if (isTransparent(value)) return 'transparent';
  return 'rgb';
}

export function ColourField({ value, onChange, nullable, disabled }: ColourFieldProps) {
  const id = useId();
  const mode = modeOf(value);
  const rgb = parseRgb(value);

  function setMode(next: Mode): void {
    if (next === mode) return;
    if (next === 'none') onChange(null);
    else if (next === 'transparent') onChange(TRANSPARENT);
    else onChange(formatRgb(rgb ?? { r: 0, g: 0, b: 0 }));
  }

  return (
    <div className="field">
      <div className="segmented" role="group" aria-label="Colour mode">
        {nullable && (
          <button
            type="button"
            aria-pressed={mode === 'none'}
            disabled={disabled}
            onClick={() => setMode('none')}
          >
            none
          </button>
        )}
        <button
          type="button"
          aria-pressed={mode === 'rgb'}
          disabled={disabled}
          onClick={() => setMode('rgb')}
        >
          rgb
        </button>
        <button
          type="button"
          aria-pressed={mode === 'transparent'}
          disabled={disabled}
          onClick={() => setMode('transparent')}
          title="A hole punched through the geometry — not an unset value."
        >
          transparent
        </button>
      </div>

      {mode === 'none' && (
        <div className="nullable__none" aria-live="polite">
          none — this definition has no colour override
        </div>
      )}

      {mode === 'transparent' && (
        <div className="field__row">
          <span className="transparent-preview" aria-hidden="true" />
          <span className="hint">
            Renders as a hole. Used by tile overlay 7 and wall object 119.
          </span>
        </div>
      )}

      {mode === 'rgb' && rgb && (
        <div className="field__row">
          <input
            id={id}
            type="color"
            value={rgbToHex(rgb)}
            disabled={disabled}
            aria-label="Colour picker"
            onChange={(e) => onChange(formatRgb(hexToRgb(e.target.value)))}
          />
          {(['r', 'g', 'b'] as const).map((channel) => (
            <input
              key={channel}
              type="number"
              min={0}
              max={255}
              step={1}
              value={rgb[channel]}
              disabled={disabled}
              aria-label={`${channel.toUpperCase()} channel`}
              onChange={(e) =>
                onChange(formatRgb({ ...rgb, [channel]: Number(e.target.value) || 0 }))
              }
            />
          ))}
        </div>
      )}

      {mode === 'rgb' && !rgb && (
        <div className="field__row">
          <input
            type="text"
            value={value ?? ''}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            aria-label="Raw colour value"
          />
          <span className="hint">unrecognised format — edited as raw text</span>
        </div>
      )}
    </div>
  );
}

/** Read-only swatch for lists. */
export function ColourSwatch({ value }: { value: string | null }) {
  if (value === null) {
    return <span className="swatch" style={{ background: 'transparent', borderStyle: 'dashed' }} />;
  }
  if (isTransparent(value)) {
    return <span className="swatch transparent-preview" style={{ width: 9, height: 9 }} />;
  }
  return <span className="swatch" style={{ background: value }} />;
}
