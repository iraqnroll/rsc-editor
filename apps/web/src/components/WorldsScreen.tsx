import { useCallback, useEffect, useRef, useState } from 'react';
import {
  broadcast,
  cancelRestart,
  kick,
  listWorlds,
  restart,
  worldPlayers,
  type OnlinePlayer,
  type WorldSummary
} from '../data/worlds.js';
import { isApiHttpError } from '../data/http.js';
import { LogPanel } from './LogPanel.js';
import { AdminLogPanel, EventsPanel } from './AuditPanels.js';
import { PlayerPanel } from './PlayerPanel.js';

/**
 * The game worlds: are they up, who is on, and the few things an admin does
 * to a running world -- tell everyone something, kick someone, restart with
 * a countdown. Every action goes to the world's control socket through the
 * server; see apps/server `routes/worlds.ts`.
 */

const POLL_MS = 3000;
const COUNTDOWNS = [0, 30, 60, 120, 300];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${seconds % 60}s`;
}

export function WorldsScreen({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [players, setPlayers] = useState<OnlinePlayer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [seconds, setSeconds] = useState(60);
  const [reason, setReason] = useState('');
  const [tab, setTab] = useState<'world' | 'events' | 'admin' | 'logs'>('world');
  const [retention, setRetention] = useState<Record<string, number> | null>(null);
  /** the Player page, over whichever tab opened it */
  const [player, setPlayer] = useState<string | null>(null);

  const world = worlds?.find((w) => w.id === selected) ?? null;

  const refresh = useCallback(async () => {
    try {
      const body = await listWorlds();
      setWorlds(body.worlds);
      setConfigError(body.configError);
      setRetention(body.retentionDays ?? null);
      setSelected((current) => current ?? body.worlds[0]?.id ?? null);
    } catch (err) {
      setError(message(err));
    }
  }, []);

  const refreshPlayers = useCallback(async () => {
    if (!selected || !world?.up) {
      setPlayers([]);
      return;
    }
    try {
      setPlayers(await worldPlayers(selected));
    } catch {
      setPlayers([]);
    }
  }, [selected, world?.up]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    ref.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [refresh, onClose]);

  useEffect(() => {
    void refreshPlayers();
  }, [refreshPlayers, worlds]);

  /** Run an action, say how it went, and re-read the world. */
  async function act(label: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
      setError(null);
      setNotice(label);
    } catch (err) {
      setNotice(null);
      setError(isApiHttpError(err) ? err.message : message(err));
    }
    await refresh();
    await refreshPlayers();
  }

  return (
    <div className="modal__scrim" onClick={onClose} role="presentation">
      <div
        className="modal modal--access"
        role="dialog"
        aria-modal="true"
        aria-label="Worlds"
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__header">
          Worlds
          <div className="tabs worlds__tabs" role="tablist" aria-label="Worlds view">
            {(
              [
                ['world', 'World'],
                ['events', 'Events'],
                ['admin', 'Admin log'],
                ['logs', 'Server logs']
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className="tab"
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
            close
          </button>
        </div>

        {configError && <p className="hint worlds__error">Worlds file: {configError}</p>}

        {player && (
          <PlayerPanel
            // Any world that is up can answer: they share one account database.
            world={(worlds ?? []).find((w) => w.id === selected && w.up)?.id ?? (worlds ?? []).find((w) => w.up)?.id ?? selected ?? ''}
            username={player}
            onBack={() => setPlayer(null)}
          />
        )}

        {!player && tab === 'events' && (
          <>
            {retention && (
              <p className="hint audit__scope">
                Kept for:{' '}
                {Object.entries(retention)
                  .map(([type, days]) => `${type === '*' ? 'everything else' : type} ${days} days`)
                  .join(', ')}
                . Chat and private messages are personal data: tell your players they are logged.
              </p>
            )}
            <EventsPanel worlds={worlds ?? []} onOpenPlayer={setPlayer} />
          </>
        )}
        {!player && tab === 'admin' && <AdminLogPanel />}
        {!player && tab === 'logs' && <LogPanel />}
        {!player && tab === 'world' && (
        <>
        {worlds && worlds.length === 0 && !configError && (
          <p className="hint access__intro">
            No game worlds are configured on this server. deploy/game/install.sh sets them up.
          </p>
        )}

        <div className="worlds__list" role="tablist" aria-label="Worlds">
          {(worlds ?? []).map((w) => (
            <button
              key={w.id}
              type="button"
              role="tab"
              aria-selected={w.id === selected}
              className="worlds__card"
              onClick={() => setSelected(w.id)}
            >
              <span className={`worlds__dot ${w.up ? 'is-up' : 'is-down'}`} aria-hidden />
              <span className="worlds__name">{w.name}</span>
              <span className="worlds__meta">
                {w.status
                  ? `${w.status.players} / ${w.status.capacity} online · up ${duration(w.status.uptimeSeconds)} · ${w.status.memoryMB} MB`
                  : `down${w.error ? ` — ${w.error}` : ''}`}
              </span>
              {w.events && (
                <span className="worlds__meta">
                  {w.events.error
                    ? `events: ${w.events.error}`
                    : w.events.lastSync
                      ? `events collected ${new Date(w.events.lastSync).toLocaleTimeString()}`
                      : 'events: nothing new yet'}
                </span>
              )}
            </button>
          ))}
        </div>

        {error && <p className="hint worlds__error" role="alert">{error}</p>}
        {notice && !error && <p className="hint worlds__notice">{notice}</p>}

        {world?.status && (
          <>
            {world.status.shutdown && (
              <div className="field__row worlds__pending">
                <span>
                  Restarting at {new Date(world.status.shutdown.at).toLocaleTimeString()}
                  {world.status.shutdown.reason ? ` — ${world.status.shutdown.reason}` : ''}
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void act('Restart cancelled.', () => cancelRestart(world.id))}
                >
                  Cancel restart
                </button>
              </div>
            )}

            <form
              className="field__row worlds__row"
              onSubmit={(e) => {
                e.preventDefault();
                const say = text.trim();
                if (!say) return;
                void act(`Sent to ${world.status!.players} player(s).`, async () => {
                  await broadcast(world.id, say);
                  setText('');
                });
              }}
            >
              <input
                aria-label="Message to everyone"
                placeholder="message everyone in this world"
                value={text}
                maxLength={200}
                onChange={(e) => setText(e.target.value)}
              />
              <button type="submit" className="btn btn--sm btn--primary" disabled={!text.trim()}>
                Broadcast
              </button>
            </form>

            <form
              className="field__row worlds__row"
              onSubmit={(e) => {
                e.preventDefault();
                const who = world.status!.players;
                const ok = window.confirm(
                  seconds === 0
                    ? `Restart ${world.name} now? ${who} player(s) will be saved and disconnected.`
                    : `Restart ${world.name} in ${seconds} seconds? Players see a countdown, then are saved and disconnected.`
                );
                if (!ok) return;
                void act(
                  seconds === 0 ? 'Restarting now.' : `Restarting in ${seconds} seconds.`,
                  () => restart(world.id, seconds, reason.trim())
                );
              }}
            >
              <select aria-label="Countdown" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
                {COUNTDOWNS.map((s) => (
                  <option key={s} value={s}>
                    {s === 0 ? 'now' : s < 60 ? `in ${s}s` : `in ${s / 60} min`}
                  </option>
                ))}
              </select>
              <input
                aria-label="Reason"
                placeholder="reason shown to players (optional)"
                value={reason}
                maxLength={120}
                onChange={(e) => setReason(e.target.value)}
              />
              <button type="submit" className="btn btn--sm">
                Restart
              </button>
            </form>

            <div className="access__table-wrap">
              <table className="access__table">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Rank</th>
                    <th>Combat</th>
                    <th>Position</th>
                    <th>IP</th>
                    <th>Online for</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {players.length === 0 && (
                    <tr>
                      <td colSpan={7} className="hint">
                        Nobody is online.
                      </td>
                    </tr>
                  )}
                  {players.map((p) => (
                    <tr key={p.username}>
                      <td>
                        <button type="button" className="link" title="Open the player page" onClick={() => setPlayer(p.username)}>
                          {p.username}
                        </button>
                      </td>
                      <td>{p.rankName}</td>
                      <td>{p.combatLevel}</td>
                      <td>
                        {p.x}, {p.y}
                      </td>
                      <td>{p.ip ?? '—'}</td>
                      <td>{p.loggedInAt ? duration(Math.round((Date.now() - Date.parse(p.loggedInAt)) / 1000)) : '—'}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => {
                            if (!window.confirm(`Kick ${p.username}? They are saved first.`)) return;
                            void act(`Kicked ${p.username}.`, () => kick(world.id, p.username));
                          }}
                        >
                          Kick
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        </>
        )}
      </div>
    </div>
  );
}

/** Top-bar button: admins on an install with worlds only. */
export function WorldsButton() {
  const [show, setShow] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    listWorlds()
      .then((body) => alive && setShow(body.worlds.length > 0 || !!body.configError))
      .catch(() => alive && setShow(false));
    return () => {
      alive = false;
    };
  }, []);

  if (!show) return null;
  return (
    <>
      <button type="button" className="btn btn--sm" title="The game worlds: who is on, broadcast, kick, restart" onClick={() => setOpen(true)}>
        Worlds
      </button>
      {open && <WorldsScreen onClose={() => setOpen(false)} />}
    </>
  );
}
