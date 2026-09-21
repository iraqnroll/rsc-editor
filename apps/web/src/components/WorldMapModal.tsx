/**
 * The full-window world map.
 *
 * The rail panel is ~250 px wide; the world is 17 x 19 sectors of 48 tiles.
 * Finding somewhere you only half remember needs room, so `M` (or "expand")
 * puts the identical component in a window-sized surface. Same map, same
 * overlays, same click-to-jump — jumping closes it, because the reason you
 * opened it was to go somewhere.
 */

import { useEffect, useRef, useState } from 'react';
import { MAX_PLANES } from '@rsc-editor/schema';
import { useEditor } from '../state/editorStore.js';
import { PanelBoundary } from './PanelBoundary.js';
import { WorldMap } from './WorldMap.js';
import { downloadWorldMapSvg } from '../data/download-map-svg.js';

const PLANE_LABELS = ['ground', 'floor 1', 'floor 2', 'dungeon'];

export function WorldMapModal({ onClose }: { onClose: () => void }) {
  const activeSector = useEditor((s) => s.activeSector);
  const [plane, setPlane] = useState(activeSector?.plane ?? 0);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  async function saveSvg(): Promise<void> {
    setSaving(true);
    setProblem(await downloadWorldMapSvg(plane));
    setSaving(false);
  }

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal__scrim" onClick={onClose} role="presentation">
      <div
        className="modal modal--map"
        role="dialog"
        aria-modal="true"
        aria-label="World map"
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__header">
          World map
          <span className="spacer" />
          <div className="segmented" role="group" aria-label="Plane">
            {Array.from({ length: MAX_PLANES }, (_, p) => (
              <button key={p} type="button" aria-pressed={p === plane} onClick={() => setPlane(p)}>
                {PLANE_LABELS[p] ?? `plane ${p}`}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--sm"
            disabled={saving}
            title="Download this plane as an SVG: the map image, the sector grid and sector numbers"
            onClick={() => void saveSvg()}
          >
            {saving ? 'saving…' : 'SVG'}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
            close
          </button>
        </div>

        {problem && (
          <p className="hint worlds__error" role="alert">
            The SVG could not be made: {problem}
          </p>
        )}

        <PanelBoundary label="World map">
          <WorldMap plane={plane} variant="full" onJump={onClose} />
        </PanelBoundary>
      </div>
    </div>
  );
}
