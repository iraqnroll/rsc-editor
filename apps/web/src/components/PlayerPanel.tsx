import { useCallback, useEffect, useState } from 'react';
import {
  banPlayer,
  mutePlayer,
  playerInfo,
  resetPlayerPassword,
  searchEvents,
  setPlayerRank,
  teleportPlayer,
  type GameEvent,
  type PlayerAccount
} from '../data/worlds.js';
import { describeEvent } from './AuditPanels.js';

/**
 * One account: who they are, whether they are on, and the few things an
 * admin does to an account -- mute, ban, rank, a new password. Each needs a
 * reason, which the Admin log keeps with who did it.
 *
 * `world` is only the way in: every world shares the data server, so any
 * world that is up can answer for any account.
 */

const DURATIONS: Array<[number, string]> = [
  [60, '1 hour'],
  [1440, '1 day'],
  [1440 * 7, '7 days'],
  [1440 * 30, '30 days'],
  [-1, 'for good']
];

const RANKS: Array<[number, string]> = [
  [0, 'player'],
  [2, 'moderator'],
  [3, 'administrator']
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const until = (value: string | null) => (value === 'forever' ? 'for good' : value ? `until ${when(value)}` : null);

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function PlayerPanel({ world, username, onBack }: { world: string; username: string; onBack: () => void }) {
  const [account, setAccount] = useState<PlayerAccount | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [muteFor, setMuteFor] = useState(60);
  const [banFor, setBanFor] = useState(1440);
  const [rank, setRank] = useState(0);
  const [password, setPassword] = useState<string | null>(null);
  /** a region name, or "x y" */
  const [where, setWhere] = useState('lumbridge');

  const load = useCallback(async () => {
    try {
      const a = await playerInfo(world, username);
      setAccount(a);
      setRank(a.rank);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
    try {
      setEvents(await searchEvents({ player: username }));
    } catch {
      setEvents([]);
    }
  }, [world, username]);

  useEffect(() => {
    void load();
  }, [load]);

  const ready = reason.trim().length >= 3;

  async function act(done: string, run: () => Promise<unknown>, confirmText?: string): Promise<void> {
    if (!ready) {
      setError('Give a reason first (at least 3 characters): the admin log keeps it.');
      return;
    }
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      await run();
      setNotice(done);
      setError(null);
      setReason('');
    } catch (err) {
      setNotice(null);
      setError(message(err));
    }
    await load();
  }

  const name = account?.username ?? username;
  const muted = until(account?.mutedUntil ?? null);
  const banned = until(account?.bannedUntil ?? null);

  return (
    <div className="player">
      <div className="player__head">
        <button type="button" className="btn btn--sm btn--ghost" onClick={onBack}>
          ← back
        </button>
        <span className="player__name">{name}</span>
        {account && <span className="audit__type">{account.rankName}</span>}
        {account && (
          <span className={account.online ? 'audit__ok' : 'hint'}>
            {account.online ? `online on world ${account.world}` : 'offline'}
          </span>
        )}
      </div>

      {error && <p className="hint worlds__error">{error}</p>}
      {notice && !error && <p className="hint worlds__notice">{notice}</p>}

      {account && (
        <>
          <dl className="player__facts">
            <dt>Created</dt>
            <dd>
              {when(account.createdAt)}
              {account.createdFrom ? ` from ${account.createdFrom}` : ''}
            </dd>
            <dt>Last login</dt>
            <dd>
              {when(account.lastLoginAt)}
              {account.lastLoginFrom ? ` from ${account.lastLoginFrom}` : ''}
            </dd>
            {account.online && (
              <>
                <dt>Now</dt>
                <dd>
                  at {account.online.x}, {account.online.y} · combat {account.online.combatLevel} · since{' '}
                  {when(account.online.loggedInAt)}
                  {account.online.ip ? ` · ${account.online.ip}` : ''}
                </dd>
              </>
            )}
            <dt>Quest points</dt>
            <dd>{account.questPoints}</dd>
            <dt>Muted</dt>
            <dd className={muted ? 'audit__bad' : ''}>{muted ?? 'no'}</dd>
            <dt>Banned</dt>
            <dd className={banned ? 'audit__bad' : ''}>{banned ?? 'no'}</dd>
          </dl>

          <div className="player__actions">
            <input
              className="player__reason"
              aria-label="Reason"
              placeholder="reason (required for every action; kept in the admin log)"
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
            />

            <div className="field__row">
              <span className="player__label">Mute</span>
              <select aria-label="Mute for" value={muteFor} onChange={(e) => setMuteFor(Number(e.target.value))}>
                {DURATIONS.map(([m, label]) => (
                  <option key={m} value={m}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--sm"
                disabled={!ready}
                onClick={() => void act(`${name} is muted.`, () => mutePlayer(world, name, muteFor, reason.trim()))}
              >
                Mute
              </button>
              {muted && (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!ready}
                  onClick={() => void act(`${name} can talk again.`, () => mutePlayer(world, name, 0, reason.trim()))}
                >
                  Unmute
                </button>
              )}
            </div>

            <div className="field__row">
              <span className="player__label">Ban</span>
              <select aria-label="Ban for" value={banFor} onChange={(e) => setBanFor(Number(e.target.value))}>
                {DURATIONS.map(([m, label]) => (
                  <option key={m} value={m}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--sm"
                disabled={!ready}
                onClick={() =>
                  void act(
                    `${name} is banned.`,
                    () => banPlayer(world, name, banFor, reason.trim()),
                    `Ban ${name} ${DURATIONS.find(([m]) => m === banFor)?.[1]}?${account.online ? ' They are online and will be kicked.' : ''}`
                  )
                }
              >
                Ban
              </button>
              {banned && (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!ready}
                  onClick={() => void act(`${name} is no longer banned.`, () => banPlayer(world, name, 0, reason.trim()))}
                >
                  Unban
                </button>
              )}
            </div>

            <div className="field__row">
              <span className="player__label">Rank</span>
              <select aria-label="Rank" value={rank} onChange={(e) => setRank(Number(e.target.value))}>
                {RANKS.map(([r, label]) => (
                  <option key={r} value={r}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--sm"
                disabled={!ready || rank === account.rank}
                onClick={() =>
                  void act(`${name} is now a${rank === 3 ? 'n' : ''} ${RANKS.find(([r]) => r === rank)?.[1]}.`, () =>
                    setPlayerRank(world, name, rank, reason.trim())
                  )
                }
              >
                Set rank
              </button>
            </div>

            {account.online && (
              <div className="field__row">
                <span className="player__label">Teleport</span>
                <input
                  aria-label="Teleport to"
                  placeholder="region (lumbridge) or x y (120 648)"
                  value={where}
                  onChange={(e) => setWhere(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!ready || !where.trim()}
                  onClick={() => {
                    const coords = /^\s*(\d+)[\s,]+(\d+)\s*$/.exec(where);
                    const to = coords ? { x: Number(coords[1]), y: Number(coords[2]) } : { region: where.trim() };
                    void act(`${name} was moved.`, () => teleportPlayer(world, name, to, reason.trim()));
                  }}
                >
                  Teleport
                </button>
              </div>
            )}

            <div className="field__row">
              <span className="player__label">Password</span>
              <button
                type="button"
                className="btn btn--sm"
                disabled={!ready}
                onClick={() =>
                  void act(
                    'A new password is below. Pass it on; it is not shown again.',
                    async () => setPassword((await resetPlayerPassword(world, name, reason.trim())).password),
                    `Give ${name} a new password? The old one stops working.`
                  )
                }
              >
                Reset password
              </button>
              {password && (
                <>
                  <code className="player__password">{password}</code>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => void navigator.clipboard?.writeText(password)}>
                    copy
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="player__skills">
            {Object.entries(account.skills).map(([skill, s]) => (
              <span key={skill} title={`${s.experience} experience`}>
                {skill} <b>{s.level}</b>
                {s.current !== s.level ? ` (${s.current})` : ''}
              </span>
            ))}
          </div>

          <div className="access__table-wrap">
            <table className="access__table audit__table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>What</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 && (
                  <tr>
                    <td colSpan={3} className="hint">
                      No events recorded for {name}.
                    </td>
                  </tr>
                )}
                {events.slice(0, 50).map((e) => (
                  <tr key={e.id}>
                    <td className="audit__when">{when(e.at)}</td>
                    <td>
                      <span className={`audit__type audit__type--${e.type}`}>{e.type}</span>
                    </td>
                    <td>
                      {e.player && e.player !== name ? `${e.player}: ` : ''}
                      {describeEvent(e)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
