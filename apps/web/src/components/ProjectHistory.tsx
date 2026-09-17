import { useCallback, useEffect, useState } from 'react';
import { sectorKey } from '@rsc-editor/schema';
import { getApi, type HistoryEntry, type SnapshotSummary } from '../data/api.js';
import { isApiHttpError } from '../data/http.js';
import { describeOp } from '../ops/apply.js';
import { useEditor } from '../state/editorStore.js';
import { downloadExport, ExportProblems } from './ExportButton.js';

/**
 * The project's history, not just this session's: snapshots (named points in
 * the op log that can be exported as they were) and the log itself, newest
 * first, with who made each change. Clicking a sector edit jumps to it.
 */
export function ProjectHistory() {
  const headSeq = useEditor((s) => s.headSeq);
  const setActiveSector = useEditor((s) => s.setActiveSector);

  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const api = getApi();
      const [list, page] = await Promise.all([api.listSnapshots(), api.loadHistory()]);
      setSnapshots(list);
      setEntries(page.entries);
      setNext(page.next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // The head moving is what makes the log stale; a page per new op is cheap.
  useEffect(() => {
    void refresh();
  }, [refresh, headSeq]);

  async function more(): Promise<void> {
    if (next === null) return;
    const page = await getApi().loadHistory(next);
    setEntries((current) => [...current, ...page.entries]);
    setNext(page.next);
  }

  async function tag(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await getApi().createSnapshot(trimmed);
      setName('');
      setError(null);
      await refresh();
    } catch (err) {
      setError(
        isApiHttpError(err) && err.status === 409
          ? `"${trimmed}" is taken`
          : err instanceof Error
            ? err.message
            : String(err)
      );
    }
  }

  async function exportAt(snapshot: SnapshotSummary): Promise<void> {
    setBusy(snapshot.id);
    setProblems(await downloadExport(snapshot.id));
    setBusy(null);
  }

  async function remove(snapshot: SnapshotSummary): Promise<void> {
    await getApi().deleteSnapshot(snapshot.id);
    await refresh();
  }

  return (
    <>
      <div className="panel__header" style={{ borderTop: '1px solid var(--line)' }}>
        Snapshots
      </div>
      <form
        className="field__row"
        style={{ padding: '6px 8px' }}
        onSubmit={(e) => {
          e.preventDefault();
          void tag();
        }}
      >
        <input
          aria-label="Snapshot name"
          placeholder={`name for seq ${headSeq}`}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="btn btn--sm" disabled={!name.trim()}>
          Tag
        </button>
      </form>
      {error && <div className="hint" role="alert" style={{ padding: '0 10px 6px' }}>{error}</div>}
      <div className="snapshots">
        {snapshots.length === 0 && <div className="empty">No snapshots yet.</div>}
        {snapshots.map((s) => (
          <div key={s.id} className="histrow" title={s.description ?? undefined}>
            <span className="histrow__kind">seq {s.seq}</span>
            <span className="row__name">{s.name}</span>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={busy !== null}
              title="Download the project as it was at this snapshot"
              onClick={() => void exportAt(s)}
            >
              {busy === s.id ? '…' : 'export'}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              aria-label={`delete snapshot ${s.name}`}
              onClick={() => void remove(s)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="panel__header" style={{ borderTop: '1px solid var(--line)' }}>
        Project log
      </div>
      <div className="project-log">
        {entries.length === 0 && <div className="empty">No edits in this project yet.</div>}
        {entries.map((entry) => {
          const op = entry.op;
          const where =
            op.type === 'definition'
              ? `${op.defKind}[${op.index}]`
              : op.type === 'asset'
                ? `${op.assetKind} ${op.key}`
                : sectorKey(op.sector);
          return (
            <button
              key={entry.seq}
              type="button"
              className="histrow histrow--button"
              title={new Date(entry.createdAt).toLocaleString()}
              disabled={op.type !== 'sector'}
              onClick={() => op.type === 'sector' && setActiveSector(op.sector)}
            >
              <span className="histrow__kind">{entry.seq}</span>
              <span className="row__name">
                {describeOp(op)} · {where}
              </span>
              <span className="histrow__count">{entry.actorName}</span>
            </button>
          );
        })}
        {next !== null && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void more()}>
            older…
          </button>
        )}
      </div>

      {problems && <ExportProblems problems={problems} onClose={() => setProblems(null)} />}
    </>
  );
}
