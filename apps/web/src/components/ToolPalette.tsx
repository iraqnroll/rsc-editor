/**
 * Left rail: the tool grid and the active tool's options.
 *
 * Nothing here edits anything. A tool panel only reads and writes
 * `toolSettings`; the actual edit happens when the viewport reports a gesture
 * and `src/state/gesture.ts` turns (tool + settings + tile) into ops.
 */

import { clampLane } from '../ops/apply.js';
import { BRUSH_SHAPES, ELEVATION_MODES, FALLOFFS, WALL_EDGES, WALL_EDGE_LABELS } from '../ops/builders.js';
import { TOOLS, type ToolId } from '../tools/registry.js';
import { useEditor } from '../state/editorStore.js';
import { copySelection } from '../state/gesture.js';
import { TERRAIN_PALETTE, terrainBand, terrainColour } from '../data/terrain-palette.js';
import { NumberField, Readout, Section, Segmented, Slider, Toggle } from './controls.js';
import { DefPicker } from './DefPicker.js';
import { SectorBrowser } from './SectorBrowser.js';

export function ToolPalette() {
  const activeTool = useEditor((s) => s.activeTool);
  const setTool = useEditor((s) => s.setTool);

  return (
    <div className="pane pane--left">
      <div className="panel__header">Tools</div>

      <div className="toolgrid" role="radiogroup" aria-label="Editing tool">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="tool"
            aria-pressed={t.id === activeTool}
            title={`${t.label} (${t.hotkey}) — ${t.blurb}`}
            onClick={() => setTool(t.id)}
          >
            <span className="tool__key">{t.hotkey}</span>
            <span className="tool__glyph" aria-hidden="true">
              {t.glyph}
            </span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="pane__scroll">
        <ToolOptions tool={activeTool} />
        <SectorBrowser />
        <OverlayToggles />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- options -- */

function ToolOptions({ tool }: { tool: ToolId }) {
  switch (tool) {
    case 'select':
      return (
        <Section title="Select">
          <p className="hint">
            Click a tile to make its sector active. This tool never writes, so it works on
            sectors you do not hold.
          </p>
        </Section>
      );
    case 'elevation':
      return <ElevationOptions />;
    case 'paint':
      return <PaintOptions />;
    case 'wall':
      return <WallOptions />;
    case 'roof':
      return <RoofOptions />;
    case 'scenery':
      return <SceneryOptions />;
    case 'region':
      return <RegionOptions />;
  }
}

function ElevationOptions() {
  const s = useEditor((st) => st.toolSettings.elevation);
  const update = useEditor((st) => st.updateToolSettings);
  return (
    <Section title="Elevation brush">
      <Segmented
        label="Mode"
        value={s.mode}
        options={ELEVATION_MODES}
        onChange={(mode) => update('elevation', { mode })}
      />
      <Segmented
        label="Shape"
        value={s.shape}
        options={BRUSH_SHAPES}
        onChange={(shape) => update('elevation', { shape })}
      />
      <Slider
        label="Radius"
        value={s.radius}
        min={0}
        max={16}
        suffix=" tiles"
        onChange={(radius) => update('elevation', { radius })}
      />
      <Slider
        label="Strength"
        value={s.strength}
        min={0.05}
        max={1}
        step={0.05}
        onChange={(strength) => update('elevation', { strength })}
      />
      <Segmented
        label="Falloff"
        value={s.falloff}
        options={FALLOFFS}
        onChange={(falloff) => update('elevation', { falloff })}
      />
      <p className="hint">
        Hold <span className="kbd">Alt</span> to invert raise/lower. <span className="kbd">[</span>
        {' / '}
        <span className="kbd">]</span> resize. Elevation is 0–255; one full-strength stroke moves
        24 units at the centre.
      </p>
    </Section>
  );
}

function PaintOptions() {
  const s = useEditor((st) => st.toolSettings.paint);
  const update = useEditor((st) => st.updateToolSettings);
  const tiles = useEditor((st) => st.config?.tiles);

  return (
    <>
      <Section title="Paint">
        <Segmented
          label="Target"
          value={s.target}
          options={[
            { value: 'colour' as const, label: 'terrain colour' },
            { value: 'overlay' as const, label: 'overlay' }
          ]}
          onChange={(target) => update('paint', { target })}
        />
        <Segmented
          label="Shape"
          value={s.shape}
          options={BRUSH_SHAPES}
          onChange={(shape) => update('paint', { shape })}
        />
        <Slider
          label="Radius"
          value={s.radius}
          min={0}
          max={12}
          suffix=" tiles"
          onChange={(radius) => update('paint', { radius })}
        />
        <p className="hint">
          Paint ignores falloff: colour and overlay are indices, not magnitudes. Hold{' '}
          <span className="kbd">Alt</span> to paint index 0.
        </p>
      </Section>

      {s.target === 'colour' ? (
        <Section title="Terrain colour ramp">
          <Readout
            label={`index ${s.colourIndex}`}
            value={terrainBand(s.colourIndex)}
          />
          <div className="palette" role="radiogroup" aria-label="Terrain colour index">
            {/* Even indices only: `.hei` stores colour / 2 (see clampLane). */}
            {TERRAIN_PALETTE.map((hex, i) => i % 2 === 0 && (
              <button
                key={i}
                type="button"
                aria-pressed={i === s.colourIndex}
                aria-label={`colour ${i}`}
                title={`${i} — ${terrainBand(i)}`}
                style={{ background: hex }}
                onClick={() => update('paint', { colourIndex: i })}
              />
            ))}
          </div>
          <NumberField
            label="Index"
            value={s.colourIndex}
            min={0}
            max={254}
            onChange={(colourIndex) => update('paint', { colourIndex: clampLane('colour', colourIndex) })}
          />
          <div className="field__row">
            <span className="swatch" style={{ background: terrainColour(s.colourIndex), width: 18, height: 18 }} />
            <span className="hint">
              Ramp preview is a placeholder until packages/render exports the client ramp.
            </span>
          </div>
        </Section>
      ) : (
        <Section title="Overlay / tile type">
          <div className="list" style={{ maxHeight: 220, overflowY: 'auto' }}>
            <button
              type="button"
              className="row"
              aria-selected={s.overlayIndex === 0}
              onClick={() => update('paint', { overlayIndex: 0 })}
            >
              <span className="row__idx">0</span>
              <span className="row__name">none (bare terrain)</span>
            </button>
            {(tiles ?? []).map((t, i) => (
              <button
                key={i}
                type="button"
                className="row"
                aria-selected={s.overlayIndex === i + 1}
                onClick={() => update('paint', { overlayIndex: i + 1 })}
              >
                <span className="row__idx">{i + 1}</span>
                <span
                  className="swatch"
                  style={
                    t.colour === 'transparent' || t.colour === null
                      ? { background: 'transparent', borderStyle: 'dashed' }
                      : { background: t.colour }
                  }
                />
                <span className="row__name">
                  {t.type ?? 'untyped'}
                  {t.colour === 'transparent' ? ' — transparent (hole)' : ''}
                </span>
                {typeof t.texture === 'number' && <span className="row__tag">tex {t.texture}</span>}
              </button>
            ))}
          </div>
          <p className="hint">
            Overlay 7 is the &quot;hole&quot; tile — its colour is literally{' '}
            <code>transparent</code>, which is geometry, not a missing value.
          </p>
        </Section>
      )}
    </>
  );
}

function WallOptions() {
  const s = useEditor((st) => st.toolSettings.wall);
  const update = useEditor((st) => st.updateToolSettings);
  return (
    <Section title="Walls">
      <Segmented
        label="Edge"
        value={s.edge}
        options={WALL_EDGES.map((e) => ({ value: e, label: WALL_EDGE_LABELS[e] }))}
        onChange={(edge) => update('wall', { edge })}
      />
      <Toggle label="Erase mode" checked={s.erase} onChange={(erase) => update('wall', { erase })} />
      <DefPicker
        kind="wallObjects"
        label="Wall object"
        value={s.wallId}
        preview
        onChange={(wallId) => update('wall', { wallId })}
      />
      <p className="hint">
        Diagonals share the <code>wallsDiagonal</code> lane with scenery object ids, so a
        diagonal cannot be placed on a tile that carries an object — the editor will say so
        rather than overwrite it.
      </p>
    </Section>
  );
}

function RoofOptions() {
  const s = useEditor((st) => st.toolSettings.roof);
  const update = useEditor((st) => st.updateToolSettings);
  const roofs = useEditor((st) => st.config?.roofs);
  return (
    <Section title="Roof">
      <Toggle label="Erase mode" checked={s.erase} onChange={(erase) => update('roof', { erase })} />
      <Slider
        label="Radius"
        value={s.radius}
        min={0}
        max={12}
        suffix=" tiles"
        onChange={(radius) => update('roof', { radius })}
      />
      <Segmented
        label="Shape"
        value={s.shape}
        options={BRUSH_SHAPES}
        onChange={(shape) => update('roof', { shape })}
      />
      <div className="field">
        <div className="field__label">
          <span>Roof</span>
          <span className="meta">#{s.roofId}</span>
        </div>
        <div className="list" style={{ border: '1px solid var(--line)', borderRadius: 4 }}>
          {(roofs ?? []).map((r, i) => (
            <button
              key={i}
              type="button"
              className="row"
              aria-selected={s.roofId === i + 1}
              onClick={() => update('roof', { roofId: i + 1 })}
            >
              <span className="row__idx">{i + 1}</span>
              <span className="row__name">
                height {r.height}, texture {r.texture}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}

function SceneryOptions() {
  const s = useEditor((st) => st.toolSettings.scenery);
  const update = useEditor((st) => st.updateToolSettings);
  const objects = useEditor((st) => st.config?.objects);
  const selected = objects?.[s.objectId];

  return (
    <Section title="Scenery">
      <Segmented
        label="Mode"
        value={s.mode}
        options={['place', 'rotate', 'remove']}
        onChange={(mode) => update('scenery', { mode })}
      />
      <Slider
        label="Direction"
        value={s.direction}
        min={0}
        max={7}
        onChange={(direction) => update('scenery', { direction })}
      />
      <DefPicker
        kind="objects"
        label="Object"
        value={s.objectId}
        preview
        onChange={(objectId) => update('scenery', { objectId })}
      />
      {selected && (
        <Readout
          label="Footprint"
          value={
            selected.width === 0 && selected.height === 0
              ? '0 x 0 (real in the cache)'
              : `${selected.width} x ${selected.height}`
          }
        />
      )}
      <p className="hint">
        Stored as <code>objectId + 48001</code> in the <code>wallsDiagonal</code> lane. Hold{' '}
        <span className="kbd">Alt</span> to delete; in rotate mode <span className="kbd">Shift</span>{' '}
        turns the other way.
      </p>
    </Section>
  );
}

function RegionOptions() {
  const s = useEditor((st) => st.toolSettings.region);
  const update = useEditor((st) => st.updateToolSettings);
  const selection = useEditor((st) => st.selection);
  const clipboard = useEditor((st) => st.clipboard);

  const w = selection ? Math.abs(selection.x1 - selection.x0) + 1 : 0;
  const h = selection ? Math.abs(selection.y1 - selection.y0) + 1 : 0;

  return (
    <Section title="Region">
      <Segmented
        label="Mode"
        value={s.mode}
        options={['select', 'fill', 'paste']}
        onChange={(mode) => update('region', { mode })}
      />
      <Readout
        label="Selection"
        value={selection ? `${w} x ${h} (${w * h} tiles)` : 'none'}
      />
      <div className="field__row">
        <button type="button" className="btn btn--sm" disabled={!selection} onClick={copySelection}>
          Copy
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={!selection}
          onClick={() => useEditor.getState().setSelection(null)}
        >
          Clear
        </button>
      </div>
      <Readout
        label="Clipboard"
        value={clipboard ? `${clipboard.width} x ${clipboard.height}` : 'empty'}
      />

      {s.mode === 'fill' && (
        <>
          <div className="field">
            <div className="field__label">
              <label htmlFor="fill-lane">Lane</label>
            </div>
            <select
              id="fill-lane"
              value={s.fillLane}
              onChange={(e) =>
                update('region', { fillLane: e.target.value as typeof s.fillLane })
              }
            >
              {[
                'elevation',
                'colour',
                'overlay',
                'direction',
                'wallsVertical',
                'wallsHorizontal',
                'wallsRoof',
                'wallsDiagonal'
              ].map((lane) => (
                <option key={lane} value={lane}>
                  {lane}
                </option>
              ))}
            </select>
          </div>
          <NumberField
            label="Value"
            value={s.fillValue}
            onChange={(fillValue) => update('region', { fillValue })}
          />
          <p className="hint">Click in the viewport to fill the current selection.</p>
        </>
      )}

      {s.mode === 'paste' && (
        <p className="hint">
          Click to paste the clipboard with its top-left corner on that tile. A paste that
          crosses into a sector you do not hold is held back, not clipped.
        </p>
      )}
    </Section>
  );
}

function OverlayToggles() {
  const showGrid = useEditor((s) => s.showGrid);
  const showSectorBorders = useEditor((s) => s.showSectorBorders);
  const showLockTint = useEditor((s) => s.showLockTint);
  const toggle = useEditor((s) => s.toggleOverlay);
  return (
    <Section title="Overlays" defaultOpen={false}>
      <Toggle label="Tile grid" checked={showGrid} onChange={() => toggle('showGrid')} />
      <Toggle
        label="Sector borders"
        checked={showSectorBorders}
        onChange={() => toggle('showSectorBorders')}
      />
      <Toggle
        label="Lock ownership tint"
        checked={showLockTint}
        onChange={() => toggle('showLockTint')}
      />
    </Section>
  );
}
