/**
 * Bottom bar: connection, position, lock state, presence.
 *
 * The lock readout is the important one. "Read-only because someone else holds
 * this sector" must never be a mystery — the status bar names them, in their
 * colour, matching the viewport tint and the minimap cell.
 */

import { sectorKey } from '@rsc-editor/schema';
import { useEditor } from '../state/editorStore.js';
import { TOOL_BY_ID } from '../tools/registry.js';

export function StatusBar({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const connection = useEditor((s) => s.connection);
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

  const lock = activeSector ? locks[sectorKey(activeSector)] : undefined;
  const mine = !!lock && lock.userId === me?.userId;
  const owner = lock ? (mine ? me : peers[lock.userId]) : undefined;

  const dotColour =
    connection === 'ready' ? 'var(--ok)' : connection === 'error' ? 'var(--danger)' : 'var(--warn)';

  return (
    <footer className="statusbar">
      <span className="statusbar__item" title={`Data source: ${apiMode}`}>
        <span className="dot" style={{ background: dotColour }} />
        {connection}
        {apiMode === 'mock' && <strong style={{ color: 'var(--warn)' }}>&nbsp;mock data</strong>}
      </span>

      <span className="statusbar__item statusbar__item--mono">
        {hoverTile ? `${hoverTile.wx}, ${hoverTile.wy}` : '—, —'}
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
