import { useCallback, useEffect, useRef, useState } from 'react';
import { listLogUnits, readLog } from '../data/worlds.js';

/**
 * The game host's systemd logs, in the Worlds screen.
 *
 * The Events tab says what happened in the game; this says what happened to
 * the processes running it. The two questions arrive together -- "players got
 * disconnected and lost progress" is answered by `rsc-game-data` having died,
 * which the game's own event log cannot show, because nothing was there to
 * write it down.
 *
 * Deliberately a tail and not a follow: a live stream is a socket, a backlog
 * and a scroll position to fight with, and the question here is nearly always
 * "what does it say right now".
 */

const LINE_COUNTS = [100, 200, 500, 1000];

/** journalctl's `-o short-iso`: "2026-09-21T12:22:31+0300 host unit[pid]: text". */
const ENTRY = /^(\S+)\s+\S+\s+([^:]+):\s?(.*)$/;

function Line({ text }: { text: string }) {
  const parsed = ENTRY.exec(text);
  if (!parsed) return <div className="logs__line">{text}</div>;
  const [, stamp, source, message] = parsed;
  // bole (the game's logger) writes JSON lines; show the message, keep the
  // rest in the title, or the panel is 90% punctuation.
  let body = message ?? '';
  let level: string | null = null;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    if (typeof json.message === 'string') {
      level = typeof json.level === 'string' ? json.level : null;
      const name = typeof json.name === 'string' ? `${json.name}: ` : '';
      body = `${name}${json.message}`;
    }
  } catch {
    // not JSON: a plain systemd line, which is already readable
  }
  return (
    <div className={`logs__line${level === 'error' ? ' logs__line--error' : ''}`} title={text}>
      <span className="logs__when">{(stamp ?? '').replace('T', ' ').slice(0, 19)}</span>
      <span className="logs__unit">{(source ?? '').replace(/\[\d+\]$/, '')}</span>
      <span className="logs__text">{body}</span>
    </div>
  );
}

export function LogPanel() {
  const [units, setUnits] = useState<string[] | null>(null);
  const [unit, setUnit] = useState<string | null>(null);
  const [lines, setLines] = useState(200);
  const [log, setLog] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const foot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void listLogUnits()
      .then((list) => {
        setUnits(list);
        setUnit((current) => current ?? list[0] ?? null);
      })
      .catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)));
  }, []);

  const refresh = useCallback(async () => {
    if (!unit) return;
    setBusy(true);
    try {
      const body = await readLog(unit, lines);
      setLog(body.lines);
      setProblem(body.error);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }, [unit, lines]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The newest line is the one being looked for.
  useEffect(() => {
    foot.current?.scrollIntoView({ block: 'end' });
  }, [log]);

  const shown = filter
    ? log.filter((line) => line.toLowerCase().includes(filter.toLowerCase()))
    : log;

  if (units !== null && units.length === 0) {
    return <p className="hint">This install has no unit logs configured (GAME_LOG_UNITS).</p>;
  }

  return (
    <div className="logs">
      <div className="field__row">
        <select
          aria-label="Unit"
          value={unit ?? ''}
          onChange={(e) => setUnit(e.target.value)}
          disabled={!units}
        >
          {(units ?? []).map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <select aria-label="Lines" value={lines} onChange={(e) => setLines(Number(e.target.value))}>
          {LINE_COUNTS.map((n) => (
            <option key={n} value={n}>
              last {n}
            </option>
          ))}
        </select>
        <input
          aria-label="Filter"
          placeholder="filter, e.g. error"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void refresh()}>
          {busy ? 'reading…' : 'refresh'}
        </button>
      </div>

      {problem && <p className="hint worlds__error">{problem}</p>}

      <div className="logs__pane">
        {shown.length === 0 && !problem && (
          <p className="hint">{log.length ? 'Nothing matches that filter.' : 'No entries.'}</p>
        )}
        {shown.map((line, i) => (
          <Line key={`${i}-${line.slice(0, 32)}`} text={line} />
        ))}
        <div ref={foot} />
      </div>
    </div>
  );
}
