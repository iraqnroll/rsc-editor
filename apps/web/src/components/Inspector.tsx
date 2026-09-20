/**
 * Right pane: what is under the cursor, the definition editor, and history.
 */

import { useState } from 'react';
import { SECTOR_WIDTH, sectorKey } from '@rsc-editor/schema';
import type { RscConfig } from '@rsc-editor/schema';
import { useEditor } from '../state/editorStore.js';
import { isSpawnTile } from '../data/spawn.js';
import { readDiagonalLane } from '../ops/builders.js';
import { gameCoord } from '../data/world-map.js';
import type { WorldTile } from '../ops/coords.js';
import { DefinitionEditor } from '../defs/DefinitionEditor.js';
import { HistoryPanel } from './HistoryPanel.js';
import { EntitiesOnTile, SelectedEntity } from './EntityInspector.js';
import { Readout, Section } from './controls.js';
import { terrainBand, terrainColour } from '../data/terrain-palette.js';

type Tab = 'inspect' | 'definitions' | 'history';

export function Inspector() {
  const [tab, setTab] = useState<Tab>('inspect');
  return (
    <div className="pane pane--right">
      <div className="tabs" role="tablist" aria-label="Inspector">
        {(
          [
            ['inspect', 'Inspect'],
            ['definitions', 'Definitions'],
            ['history', 'History']
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'inspect' && (
        <div className="pane__scroll">
          <SelectedEntity />
          <TileInspector />
          <EntitiesOnTile />
          <SectorInspector />
        </div>
      )}
      {tab === 'definitions' && <DefinitionEditor />}
      {tab === 'history' && <HistoryPanel />}
    </div>
  );
}

/* ----------------------------------------------------------------- tile -- */

function TileInspector() {
  const hoverTile = useEditor((s) => s.hoverTile);
  const readSector = useEditor((s) => s.readSector);
  const config = useEditor((s) => s.config);

  if (!hoverTile) {
    return (
      <Section title="Tile">
        <p className="hint">Move the pointer over the viewport.</p>
      </Section>
    );
  }

  const coord = {
    plane: hoverTile.plane,
    x: Math.floor(hoverTile.wx / SECTOR_WIDTH),
    y: Math.floor(hoverTile.wy / SECTOR_WIDTH)
  };
  const buffers = readSector(coord);
  const i = (hoverTile.wx % SECTOR_WIDTH) * SECTOR_WIDTH + (hoverTile.wy % SECTOR_WIDTH);

  if (!buffers) {
    return (
      <Section title="Tile">
        <Readout label="World" value={`${hoverTile.wx}, ${hoverTile.wy}`} />
        <GameCoords tile={hoverTile} />
        <p className="hint">Sector {sectorKey(coord)} is not loaded.</p>
      </Section>
    );
  }

  const colourIndex = buffers.colour[i] ?? 0;
  const overlay = buffers.overlay[i] ?? 0;
  const diag = readDiagonalLane(buffers.wallsDiagonal[i] ?? 0);
  const overlayDef = overlay > 0 ? config?.tiles[overlay - 1] : undefined;

  return (
    <Section title="Tile">
      <Readout label="World tile" value={`${hoverTile.wx}, ${hoverTile.wy}`} />
      <GameCoords tile={hoverTile} />
      <Readout label="Sector" value={sectorKey(coord)} />
      {isSpawnTile(hoverTile.plane, hoverTile.wx, hoverTile.wy) && (
        <div className="field__label" title="rsc-server teleports arriving and respawning players here">
          <span>Spawn</span>
          <span className="meta" style={{ color: '#ff5fa2' }}>
            players arrive here
          </span>
        </div>
      )}
      <Readout label="Lane index" value={i} />
      <Readout label="Elevation" value={buffers.elevation[i] ?? 0} />
      <div className="field__label">
        <span>Colour</span>
        <span className="meta">
          <span
            className="swatch"
            style={{ background: terrainColour(colourIndex), display: 'inline-block', verticalAlign: -1 }}
          />{' '}
          {colourIndex} &middot; {terrainBand(colourIndex)}
        </span>
      </div>
      <Readout
        label="Overlay"
        value={
          overlay === 0
            ? 'none'
            : `${overlay}${overlayDef?.type ? ` (${overlayDef.type})` : ''}${
                overlayDef?.colour === 'transparent' ? ' — transparent' : ''
              }`
        }
      />
      <Readout label="Direction" value={buffers.direction[i] ?? 0} />
      <Readout label="Wall horizontal" value={describeWall(buffers.wallsHorizontal[i] ?? 0, config)} />
      <Readout label="Wall vertical" value={describeWall(buffers.wallsVertical[i] ?? 0, config)} />
      <Readout label="Roof" value={valueOrNone(buffers.wallsRoof[i])} />
      <Readout
        label="Diagonal lane"
        value={
          diag.kind === 'none'
            ? 'none'
            : diag.kind === 'wall'
              ? `${describeWall(diag.id + 1, config)} (${diag.edge === 'diagonal-nwse' ? '\\' : '/'})`
              : `object ${diag.id}`
        }
      />
      {diag.kind === 'object' && config?.objects[diag.id] && (
        <p className="hint">
          {config.objects[diag.id]?.name} — {config.objects[diag.id]?.width} x{' '}
          {config.objects[diag.id]?.height}
        </p>
      )}
    </Section>
  );
}

function valueOrNone(v: number | undefined): string {
  return !v ? 'none' : String(v);
}

/**
 * The tile in game coordinates, which is the space `rsc-server` plugins are
 * written in -- `player.teleport(x, y)`, spawn lists, region bounds.
 *
 * Worth its own readout because the two spaces differ by a constant nobody
 * remembers: world tiles count sectors from 0 and keep the plane separate,
 * game coordinates drop the unpopulated regions (x - 2304, y - 1776) and fold
 * the plane back in (+944 per storey). Someone pasting a world tile into a
 * plugin lands 2304 tiles east of where they meant, which is off the map --
 * silently, because nothing on either side validates it.
 */
function GameCoords({ tile }: { tile: WorldTile }) {
  const game = gameCoord(tile.plane, tile.wx, tile.wy);

  return (
    <div
      className="field__label"
      title={`Game coordinates -- paste into rsc-server plugins, e.g. player.teleport(${game.x}, ${game.y})`}
    >
      <span>Game (x, y)</span>
      <span className="meta">{`${game.x}, ${game.y}`}</span>
    </div>
  );
}

/* --------------------------------------------------------------- sector -- */

function SectorInspector() {
  const activeSector = useEditor((s) => s.activeSector);
  const sectors = useEditor((s) => s.sectors);
  const locks = useEditor((s) => s.locks);
  const me = useEditor((s) => s.me);
  const peers = useEditor((s) => s.peers);

  if (!activeSector) return null;
  const key = sectorKey(activeSector);
  const loaded = sectors[key];
  const lock = locks[key];
  const owner = lock ? (lock.userId === me?.userId ? me : peers[lock.userId]) : undefined;

  return (
    <Section title="Sector">
      <Readout label="Key" value={key} />
      <Readout label="Loaded" value={loaded ? `yes (rev ${loaded.rev})` : 'no'} />
      <Readout label="Members only" value={loaded?.members ? 'yes' : 'no'} />
      <div className="field__label">
        <span>Lock</span>
        <span className="meta">
          {lock ? (
            <>
              <span
                className="dot"
                style={{ background: owner?.colour ?? '#f2b23e', display: 'inline-block', verticalAlign: 0 }}
              />{' '}
              {lock.userId === me?.userId ? 'you' : lock.displayName}
            </>
          ) : (
            'free'
          )}
        </span>
      </div>
      {lock && lock.userId !== me?.userId && (
        <p className="hint">
          Read-only. {lock.displayName} holds this sector; their edits stream in live.
        </p>
      )}
    </Section>
  );
}

/** A wall lane value (definition index + 1) as "wall 3 Window", flagging ones the client hides. */
function describeWall(stored: number, config: RscConfig | null | undefined): string {
  if (stored <= 0) return 'none';
  const id = stored - 1;
  const def = config?.wallObjects[id];
  if (!def) return `wall ${id} (undefined)`;
  return `wall ${id} ${def.name}${def.invisible ? ' — hidden in game' : ''}`;
}
