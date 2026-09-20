/**
 * Bottom bar: connection, position, lock state, presence.
 *
 * Two readouts here exist to stop a specific lie.
 *
 * The first is the data source. "mock data" has to be impossible to miss, and
 * so does its opposite — someone who thinks they are editing a scratch world
 * and is actually editing the shared one is the worse of the two mistakes, so
 * live mode is labelled just as loudly.
 *
 * The second is the link. `reconnecting` means edits are being applied
 * optimistically to a local mirror that nobody else can see and that has not
 * been sequenced. That is a materially different state from `live` and it gets
 * its own colour and a pulse, not a silent amber dot.
 */

import { sectorKey } from '@rsc-editor/schema';
import type { LinkState } from '../data/api.js';
import { useEditor } from '../state/editorStore.js';
import { gameCoord } from '../data/world-map.js';
import { TOOL_BY_ID } from '../tools/registry.js';

const LINK_LABEL: Record<LinkState, string> = {
  offline: 'offline',
  connecting: 'connecting',
  live: 'live',
  reconnecting: 'reconnecting'
};

const LINK_COLOUR: Record<LinkState, string> = {
  offline: 'var(--danger)',
  connecting: 'var(--warn)',
  live: 'var(--ok)',
  reconnecting: 'var(--warn)'
};

const LINK_TITLE: Record<LinkState, string> = {
  offline: 'Not connected. Nothing you do is reaching the server.',
  connecting: 'Opening the realtime connection.',
  live: 'Connected. Edits are sequenced by the server as you make them.',
  reconnecting:
    'The realtime connection dropped and is being retried. Edits are local and unconfirmed until it returns.'
};

export function StatusBar({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const connection = useEditor((s) => s.connection);
  const link = useEditor((s) => s.link);
  const apiMode = useEditor((s) => s.api.mode);
  const me = useEditor((s) => s.me);
  const peers = useEditor((s) => s.peers);
  const locks = useEditor((s) => s.locks);
  const activeSector = useEditor((s) => s.activeSector);
  const hoverTile = useEditor((s) => s.hoverTile);
  const activeTool = useEditor((s) => s.activeTool);
  const undoStack = useEditor((s) => s.undoStack);
  const headSeq = useEditor((s) => s.headSeq);
  const sectors = useEditor((s) => s.sectors);

  const hoverGame = hoverTile ? gameCoord(hoverTile.plane, hoverTile.wx, hoverTile.wy) : null;
  const lock = activeSector ? locks[sectorKey(activeSector)] : undefined;
  const mine = !!lock && lock.userId === me?.userId;
  const owner = lock ? (mine ? me : peers[lock.userId]) : undefined;

  // Bootstrap failures outrank the transport: "connecting" next to a red
  // bootstrap error would be two different answers to the same question.
  const state: LinkState =
    connection === 'error' || connection === 'auth-required' || connection === 'no-project'
      ? 'offline'
      : connection === 'connecting' || connection === 'idle'
        ? 'connecting'
        : link;

  return (
    <footer className="statusbar">
      <span className="statusbar__item" title={LINK_TITLE[state]}>
        <span
          className={state === 'reconnecting' ? 'dot dot--pulse' : 'dot'}
          style={{ background: LINK_COLOUR[state] }}
        />
        {/* Never the word "live" in mock mode: "live | mock data" reads as a
            contradiction, and the one thing this bar must not be is ambiguous. */}
        {apiMode === 'mock' && state === 'live' ? 'connected' : LINK_LABEL[state]}
      </span>

      <span
        className="statusbar__item"
        title={
          apiMode === 'mock'
            ? 'Generated in the browser. Nothing you do here is saved or shared.'
            : 'Real project data from the server. Edits are shared and persistent.'
        }
      >
        {apiMode === 'mock' ? (
          <strong style={{ color: 'var(--warn)' }}>mock data</strong>
        ) : (
          <strong style={{ color: 'var(--ok)' }}>live data</strong>
        )}
      </span>

      <span className="statusbar__item statusbar__item--mono" title="World tile: the space the map and the tools work in.">
        {hoverTile ? `${hoverTile.wx}, ${hoverTile.wy}` : '—, —'}
      </span>

      {/* The same tile in the server's space, so a teleport destination can be
          read straight off the bar. See GameCoords in Inspector.tsx. */}
      <span
        className="statusbar__item statusbar__item--mono"
        title={
          hoverGame
            ? `Game coordinates -- paste into rsc-server plugins, e.g. player.teleport(${hoverGame.x}, ${hoverGame.y})`
            : 'Game coordinates, the space rsc-server plugins are written in.'
        }
      >
        game {hoverGame ? `${hoverGame.x}, ${hoverGame.y}` : '—, —'}
      </span>

      <span className="statusbar__item statusbar__item--mono">
        sector {activeSector ? sectorKey(activeSector) : '—'}
      </span>

      <span className="statusbar__item">
        {lock ? (
          <>
            <span className="dot" style={{ background: owner?.colour ?? '#f2b23e' }} />
            {mine ? 'you hold this sector' : `read-only — held by ${lock.displayName}`}
          </>
        ) : (
          <>
            <span className="dot" style={{ background: 'var(--fg-2)' }} />
            unclaimed — claim to edit
          </>
        )}
      </span>

      <span className="statusbar__item">{TOOL_BY_ID[activeTool].label}</span>

      <span className="statusbar__spacer" />

      <span className="statusbar__item statusbar__item--mono" title="Local undo depth / server sequence">
        {undoStack.length} undo &middot; seq {headSeq} &middot; {Object.keys(sectors).length} loaded
      </span>

      <span className="statusbar__item">
        <span className="peers">
          {me && (
            <span className="peer" title="you">
              <span className="peer__dot" style={{ background: me.colour }} />
              {me.displayName}
            </span>
          )}
          {Object.values(peers).map((p) => (
            <span
              key={p.userId}
              className="peer"
              title={`${p.displayName}${p.activeTool ? ` — ${p.activeTool}` : ''}${
                p.selectedSector ? ` @ ${sectorKey(p.selectedSector)}` : ''
              }`}
            >
              <span className="peer__dot" style={{ background: p.colour }} />
              {p.displayName}
            </span>
          ))}
        </span>
      </span>

      <button
        type="button"
        className="statusbar__item"
        style={{ background: 'none', border: 0, borderLeft: '1px solid var(--line)', color: 'inherit', cursor: 'pointer', font: 'inherit' }}
        onClick={onShowShortcuts}
      >
        <span className="kbd">?</span> shortcuts
      </button>
    </footer>
  );
}
