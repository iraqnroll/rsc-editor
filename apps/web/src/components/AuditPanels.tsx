import { useCallback, useEffect, useState } from 'react';
import {
  searchAdminActions,
  searchEvents,
  type AdminAction,
  type EventFilter,
  type GameEvent
} from '../data/worlds.js';

/**
 * The Worlds screen's two logs: what happened in the game (game_events, as
 * the worlds reported it) and what admins did (admin_audit). Both newest
 * first, a page of 100 at a time. Clicking a player's name narrows the
 * events to them -- their timeline.
 */

export const EVENT_TYPES = ['login', 'logout', 'chat', 'pm', 'drop', 'pickup', 'death', 'command', 'admin'] as const;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const when = (iso: string) => new Date(iso).toLocaleString();

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** One line saying what an event was. */
export function describeEvent(e: GameEvent): string {
  const d = e.details;
  const where = d.x !== undefined ? ` at ${str(d.x)}, ${str(d.y)}` : '';
  switch (e.type) {
    case 'login':
      return `logged in from ${str(d.ip) || 'unknown'}${where}`;
    case 'logout':
      return `logged out after ${Math.round(Number(d.seconds ?? 0) / 60)} min${where}`;
    case 'chat':
      return `said "${str(d.message)}"${where}`;
    case 'pm':
      return `to ${e.other ?? '?'}: "${str(d.message)}"`;
    case 'drop':
      return `dropped ${str(d.amount)} x ${str(d.name) || `item ${str(d.item)}`}${where}`;
    case 'pickup':
      return `picked up ${str(d.amount)} x ${str(d.name) || `item ${str(d.item)}`}${e.other ? ` dropped by ${e.other}` : ''}${where}`;
    case 'death': {
      const dropped = Array.isArray(d.dropped) ? d.dropped.length : 0;
      return `killed by ${e.other ?? 'something'}${d.killerIsPlayer ? ' (player)' : ''}, dropped ${dropped} item(s)${where}`;
    }
    case 'command': {
      const args = Array.isArray(d.args) ? d.args.join(' ') : '';
      return `::${str(d.command)} ${args}`.trim() + (d.ran ? '' : ` — refused (${str(d.reason)})`);
    }
    case 'admin':
      return `${str(d.action)}${e.other ? ` ${e.other}` : ''}${d.message ? `: "${str(d.message)}"` : ''}${d.seconds !== undefined ? ` in ${str(d.seconds)}s` : ''}`;
    default:
      return JSON.stringify(d);
  }
}

export function EventsPanel({ worlds }: { worlds: Array<{ id: string; name: string }> }) {
  const [filter, setFilter] = useState<EventFilter>({});
  const [draft, setDraft] = useState<EventFilter>({});
  const [rows, setRows] = useState<GameEvent[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: EventFilter, append: boolean, before?: number) => {
    try {
      const page = await searchEvents({ ...f, before });
      setRows((old) => (append ? [...old, ...page] : page));
      setMore(page.length === 100);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, []);

  useEffect(() => {
    void load(filter, false);
  }, [filter, load]);

  const apply = (f: EventFilter) => {
    setDraft(f);
    setFilter({ ...f });
  };
  const types = new Set(draft.types ?? []);
  const toggle = (t: string) => {
    const next = new Set(types);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setDraft({ ...draft, types: [...next] });
  };
  const player = (name: string | null) =>
    name ? (
      <button type="button" className="link" title="Only this player" onClick={() => apply({ ...draft, player: name })}>
        {name}
      </button>
    ) : (
      '—'
    );

  return (
    <>
      <form
        className="audit__filters"
        onSubmit={(e) => {
          e.preventDefault();
          // A new object every time: Search with unchanged filters is how you refresh.
          setFilter({ ...draft });
        }}
      >
        <input
          aria-label="Player"
          placeholder="player"
          value={draft.player ?? ''}
          onChange={(e) => setDraft({ ...draft, player: e.target.value })}
        />
        <input
          aria-label="Text"
          placeholder="text in chat / PMs"
          value={draft.text ?? ''}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        />
        {worlds.length > 1 && (
          <select aria-label="World" value={draft.world ?? ''} onChange={(e) => setDraft({ ...draft, world: e.target.value })}>
            <option value="">all worlds</option>
            {worlds.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        <label className="audit__date">
          from <input type="date" aria-label="From" value={draft.from ?? ''} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label className="audit__date">
          to <input type="date" aria-label="To" value={draft.to ?? ''} onChange={(e) => setDraft({ ...draft, to: e.target.value ? `${e.target.value}T23:59:59` : '' })} />
        </label>
        <button type="submit" className="btn btn--sm btn--primary">
          Search
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => apply({})}>
          Clear
        </button>
        <div className="audit__types" role="group" aria-label="Event types">
          {EVENT_TYPES.map((t) => (
            <label key={t}>
              <input type="checkbox" checked={types.has(t)} onChange={() => toggle(t)} /> {t}
            </label>
          ))}
        </div>
      </form>

      {filter.player && (
        <p className="hint audit__scope">
          Timeline of <b>{filter.player}</b>, as either party.{' '}
          <button type="button" className="link" onClick={() => apply({ ...draft, player: undefined })}>
            show everyone
          </button>
        </p>
      )}
      {error && <p className="hint worlds__error">{error}</p>}

      <div className="access__table-wrap">
        <table className="access__table audit__table">
          <thead>
            <tr>
              <th>When</th>
              <th>World</th>
              <th>Type</th>
              <th>Player</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="hint">
                  Nothing matches.
                </td>
              </tr>
            )}
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="audit__when">{when(e.at)}</td>
                <td>{e.worldId}</td>
                <td>
                  <span className={`audit__type audit__type--${e.type}`}>{e.type}</span>
                </td>
                <td>{player(e.player)}</td>
                <td>
                  {describeEvent(e)}
                  {e.other && e.type !== 'pm' && e.type !== 'admin' && e.type !== 'pickup' && e.type !== 'death' ? (
                    <> ({player(e.other)})</>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more && (
        <button type="button" className="btn btn--sm audit__more" onClick={() => void load(filter, true, rows[rows.length - 1]?.id)}>
          Older
        </button>
      )}
    </>
  );
}

export function AdminLogPanel() {
  const [who, setWho] = useState('');
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState<{ who?: string; action?: string }>({});
  const [rows, setRows] = useState<AdminAction[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: { who?: string; action?: string }, append: boolean, before?: number) => {
    try {
      const page = await searchAdminActions({ ...f, before });
      setRows((old) => (append ? [...old, ...page] : page));
      setMore(page.length === 100);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, []);

  useEffect(() => {
    void load(applied, false);
  }, [applied, load]);

  return (
    <>
      <form
        className="audit__filters"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ who: who.trim() || undefined, action: action || undefined });
        }}
      >
        <input aria-label="Who" placeholder="admin or target" value={who} onChange={(e) => setWho(e.target.value)} />
        <select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">every action</option>
          <option value="world.">worlds (kick, broadcast, restart)</option>
          <option value="publish">publish</option>
          <option value="access.">access</option>
        </select>
        <button type="submit" className="btn btn--sm btn--primary">
          Search
        </button>
      </form>
      <p className="hint audit__scope">
        Everything an admin did outside the map, kept for good and never edited. Map edits are in each
        project&apos;s History.
      </p>
      {error && <p className="hint worlds__error">{error}</p>}
      <div className="access__table-wrap">
        <table className="access__table audit__table">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>World</th>
              <th>Target</th>
              <th>Details</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="hint">
                  Nothing matches.
                </td>
              </tr>
            )}
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="audit__when">{when(a.at)}</td>
                <td>{a.actorName}</td>
                <td>{a.action}</td>
                <td>{a.worldId ?? '—'}</td>
                <td>{a.target ?? '—'}</td>
                <td className="audit__details">
                  {Object.keys(a.details).length ? JSON.stringify(a.details) : ''}
                </td>
                <td className={a.result === 'ok' ? 'audit__ok' : 'audit__bad'}>{a.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more && (
        <button type="button" className="btn btn--sm audit__more" onClick={() => void load(applied, true, rows[rows.length - 1]?.id)}>
          Older
        </button>
      )}
    </>
  );
}
