/**
 * The two things that can stand between a load and the editor: no session, and
 * no project. Both are ordinary states of a correctly working system — a first
 * visit is anonymous, and a brand-new account owns nothing — so neither is
 * rendered as a failure.
 *
 * The sign-in panel offers whatever the server actually supports. Discord is a
 * full-page redirect (it cannot be fetched), so it is a link. Dev login only
 * exists when the server was started with `RSC_DEV_LOGIN=1` on a loopback host;
 * if it is not registered the POST 404s and we say so plainly rather than
 * leaving someone retyping their username.
 */

import { useCallback, useEffect, useState } from 'react';
import { DISCORD_LOGIN_PATH } from '../data/auth.js';
import type { ProjectSummary } from '../data/api.js';
import { useEditor } from '../state/editorStore.js';

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="gate">
      <div className="gate__card">
        <div className="gate__brand">
          RSC<span>&middot;</span>EDITOR
        </div>
        <h1 className="gate__title">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function LoginGate() {
  const signIn = useEditor((s) => s.signIn);
  const error = useEditor((s) => s.error);
  const mode = useEditor((s) => s.api.mode);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!username.trim() || busy) return;
      setBusy(true);
      await signIn(username.trim());
      setBusy(false);
    },
    [busy, signIn, username]
  );

  return (
    <Shell title="Sign in">
      <p className="hint">
        Connected to the live backend ({mode}). Editing requires an account so ops and locks
        can be attributed to you.
      </p>

      <a className="btn btn--primary gate__discord" href={DISCORD_LOGIN_PATH}>
        Sign in with Discord
      </a>

      <div className="gate__or">or, on a local server</div>

      <form onSubmit={(e) => void submit(e)} className="gate__form">
        <label className="field">
          <span className="field__label">Dev username</span>
          <input
            type="text"
            value={username}
            autoComplete="username"
            placeholder="lukas"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <button type="submit" className="btn" disabled={busy || username.trim().length === 0}>
          {busy ? 'Signing in…' : 'Dev sign in'}
        </button>
      </form>

      {error && (
        <p className="gate__error" role="alert">
          {error}
        </p>
      )}
    </Shell>
  );
}

export function ProjectGate() {
  const api = useEditor((s) => s.api);
  const openProject = useEditor((s) => s.openProject);
  const signOut = useEditor((s) => s.signOut);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .listProjects()
      .then((list) => {
        if (alive) setProjects(list);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [api]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({ name: name.trim() });
      await openProject(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Shell title="Open a project">
      {projects === null && <p className="hint">Loading projects…</p>}

      {projects !== null && projects.length === 0 && (
        <p className="hint">
          You are not a member of any project yet. Create one — it starts empty, and
          <code> tools/import-cache </code>
          fills it with map data.
        </p>
      )}

      {projects !== null && projects.length > 0 && (
        <ul className="gate__list">
          {projects.map((p) => (
            <li key={p.id}>
              <button type="button" className="gate__project" onClick={() => void openProject(p.id)}>
                <span className="gate__project-name">{p.name}</span>
                <span className="hint">
                  {p.role ?? 'member'} &middot; seq {p.headSeq}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={(e) => void create(e)} className="gate__form">
        <label className="field">
          <span className="field__label">New project name</span>
          <input
            type="text"
            value={name}
            placeholder="RSC 204"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </form>

      {error && (
        <p className="gate__error" role="alert">
          {error}
        </p>
      )}

      <button type="button" className="btn btn--sm gate__signout" onClick={() => void signOut()}>
        Sign out
      </button>
    </Shell>
  );
}
