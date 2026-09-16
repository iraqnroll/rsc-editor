/**
 * The op log, as the user sees it.
 *
 * This panel exists because it is free: undo/redo already needs the transaction
 * stack, so showing it costs nothing and makes the op model visible. If an edit
 * does not appear here, it did not go through `commitOps`, which means it is
 * also not undoable and was never sent — so this doubles as the fastest way to
 * catch a component that mutated a lane directly.
 */

import { useEditor } from '../state/editorStore.js';
import { describeOp } from '../ops/apply.js';
import { sectorKey } from '@rsc-editor/schema';
import { ProjectHistory } from './ProjectHistory.js';

export function HistoryPanel() {
  const history = useEditor((s) => s.history);
  const undoStack = useEditor((s) => s.undoStack);
  const redoStack = useEditor((s) => s.redoStack);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const headSeq = useEditor((s) => s.headSeq);

  const headId = undoStack[undoStack.length - 1]?.id;

  return (
    <>
      <div className="panel__header">
        History
        <span className="spacer" />
        <span style={{ textTransform: 'none', letterSpacing: 0 }}>server seq {headSeq}</span>
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--line)' }}>
        <button
          type="button"
          className="btn btn--sm"
          disabled={undoStack.length === 0}
          onClick={undo}
        >
          Undo ({undoStack.length})
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={redoStack.length === 0}
          onClick={redo}
        >
          Redo ({redoStack.length})
        </button>
      </div>

      <div className="pane__scroll">
        {history.length === 0 && <div className="empty">No edits yet.</div>}
        {[...history].reverse().map(({ tx, undone }) => (
          <div
            key={tx.id}
            className={`histrow${undone ? ' histrow--undone' : ''}${tx.id === headId ? ' histrow--head' : ''}`}
            title={tx.ops.map((op) => describeOp(op)).join('\n')}
          >
            <span className="histrow__kind">
              {new Date(tx.at).toLocaleTimeString([], { hour12: false })}
            </span>
            <span className="row__name">{tx.label}</span>
            <span className="histrow__count">
              {tx.ops.length > 1 ? `${tx.ops.length} ops / ` : ''}
              {tx.tiles}
            </span>
          </div>
        ))}
      </div>

      <div className="panel__header" style={{ borderTop: '1px solid var(--line)', borderBottom: 0 }}>
        Sectors touched
      </div>
      <div style={{ padding: '6px 10px' }} className="hint">
        {sectorsTouched(history).join(', ') || 'none'}
      </div>

      <ProjectHistory />
    </>
  );
}

function sectorsTouched(history: ReturnType<typeof useEditor.getState>['history']): string[] {
  const keys = new Set<string>();
  for (const { tx } of history) {
    for (const op of tx.ops) {
      if (op.type === 'sector') keys.add(sectorKey(op.sector));
    }
  }
  return [...keys].sort();
}
