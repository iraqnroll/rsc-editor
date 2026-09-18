import { useCallback, useEffect, useState } from 'react';
import {
  publishInfo,
  publishProject,
  type PublishInfo,
  type PublishStatus
} from '../data/publish.js';
import { ExportProblems } from './ExportButton.js';

/**
 * Publish to the game, and a Play link to it.
 *
 * The server only queues the cache; the game host installs it and restarts
 * (deploy/game/publish.sh), so after a click this polls `/api/publish` until
 * the game server reports back. Nothing is shown on an install without a game
 * server; everyone else sees Play, and only admins see Publish.
 */

const POLL_MS = 2000;
/** A request nobody picked up for this long means the path unit is not running. */
const STUCK_MS = 30_000;

export function PublishButton() {
  const [info, setInfo] = useState<PublishInfo | null>(null);
  const [busy, setBusy] = useState(false);
  /** the request this tab made, so its outcome is announced once */
  const [mine, setMine] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ title: string; lead: string; list: string[] } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await publishInfo());
    } catch {
      setInfo(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = !!info && (!!info.queued || info.status?.state === 'running');
  useEffect(() => {
    if (!pending && !mine) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [pending, mine, refresh]);

  // Announce the end of our own publish: a failure opens the reasons.
  useEffect(() => {
    const status = info?.status;
    if (!mine || !status || status.id !== mine || status.state === 'running') return;
    setMine(null);
    if (status.state === 'failed') {
      setProblems({
        title: 'Publish failed',
        lead: 'The game server could not install this cache. It keeps running what it had.',
        list: [status.message ?? 'no reason given -- see: journalctl -u rsc-game-publish']
      });
    }
  }, [info, mine]);

  if (!info || (!info.enabled && !info.gameUrl)) return null;

  async function run(): Promise<void> {
    const ok = window.confirm(
      'Publish this project to the game server?\n\n' +
        'The game restarts to load it, which disconnects everyone who is playing.'
    );
    if (!ok) return;
    setBusy(true);
    try {
      const outcome = await publishProject();
      if (outcome.ok) {
        setMine(outcome.queued.id);
      } else {
        setProblems({
          title: 'Publish refused',
          lead: 'Nothing was sent to the game server.',
          list: outcome.problems
        });
      }
    } catch (err) {
      setProblems({
        title: 'Publish refused',
        lead: 'Nothing was sent to the game server.',
        list: [err instanceof Error ? err.message : String(err)]
      });
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  const label = busy ? 'Building…' : pending ? stateLabel(info) : 'Publish';

  return (
    <>
      {info.enabled && (
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy || pending}
          title={describe(info.status)}
          onClick={() => void run()}
        >
          {label}
        </button>
      )}
      {info.gameUrl && (
        <a className="btn btn--sm" href={info.gameUrl} target="_blank" rel="noreferrer" title="Open the game">
          Play
        </a>
      )}
      {problems && (
        <ExportProblems
          title={problems.title}
          lead={problems.lead}
          problems={problems.list}
          onClose={() => setProblems(null)}
        />
      )}
    </>
  );
}

function stateLabel(info: PublishInfo): string {
  if (info.status?.state === 'running') return 'Publishing…';
  const waited = info.queued ? Date.now() - Date.parse(info.queued.requestedAt) : 0;
  return waited > STUCK_MS ? 'Waiting for game…' : 'Queued…';
}

/** The last publish, for the button's tooltip. */
function describe(status: PublishStatus | null): string {
  const base = 'Install this project on the game server and restart it';
  if (!status) return base;
  const when = status.finishedAt ?? status.startedAt;
  const at = when ? new Date(when).toLocaleString() : '';
  const who = [status.project, status.requestedBy && `by ${status.requestedBy}`].filter(Boolean).join(' ');
  if (status.state === 'done') return `${base}\nLast published ${at}: ${who}`;
  if (status.state === 'failed') return `${base}\nLast publish FAILED ${at}: ${status.message ?? ''}`;
  return `${base}\nPublishing ${who}…`;
}
