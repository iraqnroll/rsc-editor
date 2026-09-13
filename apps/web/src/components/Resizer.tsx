/**
 * A draggable pane divider that is also operable from the keyboard.
 *
 * Mapping panels for hours means resizing them often; a divider that only
 * responds to a 5px-wide mouse target is a papercut per hour. Tab to it and use
 * the arrow keys (Home/End snap to the limits).
 */

import { useCallback, useRef } from 'react';

export interface ResizerProps {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  /** Which side of the divider the pane being sized is on. */
  side: 'left' | 'right';
  label: string;
}

const STEP = 16;

export function Resizer({ value, onChange, min, max, side, label }: ResizerProps) {
  const dragging = useRef(false);
  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, v)), [min, max]);

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={dragging.current}
      onPointerDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        const startX = e.clientX;
        const startValue = value;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        el.dataset.dragging = 'true';

        const move = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          onChange(clamp(side === 'left' ? startValue + dx : startValue - dx));
        };
        const up = () => {
          dragging.current = false;
          el.dataset.dragging = 'false';
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
      onKeyDown={(e) => {
        const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
        const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
        if (e.key === grow) onChange(clamp(value + STEP));
        else if (e.key === shrink) onChange(clamp(value - STEP));
        else if (e.key === 'Home') onChange(min);
        else if (e.key === 'End') onChange(max);
        else return;
        e.preventDefault();
      }}
      onDoubleClick={() => onChange(clamp(side === 'left' ? 224 : 340))}
    />
  );
}
