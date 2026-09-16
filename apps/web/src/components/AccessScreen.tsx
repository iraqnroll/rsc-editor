import { useCallback, useEffect, useRef, useState } from 'react';
import { getApi, type AccessOverview, type AccessUser, type ProjectRoleName } from '../data/api.js';
import { isApiHttpError } from '../data/http.js';

/**
 * Who may sign in, and what each person can open. Instance admins only.
 *
 * One row per person, one column per project, a role in each cell. A person is
 * added by Discord username before they have ever signed in; their roles apply
 * the moment they do. Revoking signs them out everywhere at once.
 */

const ROLES: Array<ProjectRoleName | ''> = ['', 'viewer', 'editor', 'owner'];

export function AccessScreen({ onClose, me }: { onClose: () => void; me: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<AccessOverview | null>(null);
  const [handle, setHandle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');

  const refresh = useCallback(async () => {
    try {
      setData(await getApi().loadAccess());
    } catch (err) {
      setError(message(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    ref.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refresh, onClose]);

  /** Run a change, then re-read: the server is the only source of truth here. */
  async function act(change: () => Promise<void>): Promise<void> {
    try {
      await change();
      setError(null);
    } catch (err) {
      setError(message(err));
    }
    await refresh();
  }

  async function invite(): Promise<void> {
    const name = handle.trim();
    if (!name) return;
    try {
      await getApi().inviteUser(name);
      setHandle('');
      setError(null);
    } catch (err) {
      setError(isApiHttpError(err) && err.status === 409 ? `${name} is already on the list` : message(err));
    }
    await refresh();
  }

  const projects = (data?.projects ?? []).filter((p) => {
    const q = projectFilter.trim().toLowerCase();
    return !q || p.name.toLowerCase().includes(q) || p.slug.includes(q);
  });

  const shown = (data?.users ?? []).filter((u) => {
    const q = filter.trim().toLowerCase();
    return !q || u.username.includes(q) || (u.globalName ?? '').toLowerCase().includes(q);
  });

  return (
    <div className="modal__scrim" onClick={onClose} role="presentation">
      <div
        className="modal modal--access"
        role="dialog"
        aria-modal="true"
        aria-label="Access"
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__header">
          Access
          <span className="spacer" />
          <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
            close
          </button>
        </div>

        <p className="hint access__intro">
          Only people on this list can sign in. Add someone by their Discord username; the
          projects you give them apply as soon as they sign in. Admins can open every project.
        </p>

        <div className="access__bar">
          <form
            className="field__row"
            onSubmit={(e) => {
              e.preventDefault();
              void invite();
            }}
          >
            <input
              aria-label="Discord username"
              placeholder="discord username"
              value={handle}
              maxLength={33}
              onChange={(e) => setHandle(e.target.value)}
            />
            <button type="submit" className="btn btn--sm btn--primary" disabled={!handle.trim()}>
              Add
            </button>
          </form>
          <span className="spacer" />
          <input
            aria-label="Filter people"
            placeholder="filter people"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <input
            aria-label="Filter projects"
            placeholder="filter projects"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          />
        </div>
        {error && (
          <p className="gate__error" role="alert">
            {error}
          </p>
        )}

        <div className="access__table-wrap">
          <table className="access__table">
            <thead>
              <tr>
                <th className="access__sticky">Person</th>
                <th>Status</th>
                <th>Admin</th>
                {projects.map((p) => (
                  <th key={p.id} title={p.slug}>
                    {p.name}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {data && shown.length === 0 && (
                <tr>
                  <td colSpan={4 + projects.length} className="empty">
                    Nobody matches.
                  </td>
                </tr>
              )}
              {shown.map((user) => (
                <AccessRow
                  key={user.id}
                  user={user}
                  self={user.id === me}
                  projects={projects}
                  act={act}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AccessRow({
  user,
  self,
  projects,
  act
}: {
  user: AccessUser;
  self: boolean;
  projects: AccessOverview['projects'];
  act: (change: () => Promise<void>) => Promise<void>;
}) {
  const api = getApi();
  const admin = user.globalRole === 'admin';
  const roleIn = (projectId: string) =>
    user.projects.find((p) => p.projectId === projectId)?.role ?? '';

  return (
    <tr className={user.allowed ? undefined : 'access__row--revoked'} data-user={user.username}>
      <td className="access__sticky">
        <span className="row__name">{user.globalName ?? user.username}</span>{' '}
        <span className="hint">@{user.username}</span>
      </td>
      <td>
        {!user.allowed
          ? 'revoked'
          : user.pending
            ? 'invited'
            : user.lastSeenAt
              ? `seen ${new Date(user.lastSeenAt).toLocaleDateString()}`
              : 'active'}
      </td>
      <td>
        <input
          type="checkbox"
          aria-label={`${user.username} is admin`}
          checked={admin}
          disabled={self}
          onChange={(e) => void act(() => api.setUserAccess(user.id, { admin: e.target.checked }))}
        />
      </td>
      {projects.map((p) => (
        <td key={p.id}>
          {admin ? (
            <span className="hint" title="Admins can open every project">
              all
            </span>
          ) : (
            <select
              aria-label={`${user.username} in ${p.name}`}
              value={roleIn(p.id)}
              onChange={(e) =>
                void act(() =>
                  api.setProjectRole(user.id, p.id, (e.target.value || null) as ProjectRoleName | null)
                )
              }
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role || '—'}
                </option>
              ))}
            </select>
          )}
        </td>
      ))}
      <td className="access__actions">
        {user.pending ? (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void act(() => api.deleteInvite(user.id))}
          >
            remove
          </button>
        ) : user.allowed ? (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={self}
            title={self ? 'You cannot revoke yourself' : 'Sign them out and stop them signing in'}
            onClick={() => void act(() => api.setUserAccess(user.id, { allowed: false }))}
          >
            revoke
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void act(() => api.setUserAccess(user.id, { allowed: true }))}
          >
            restore
          </button>
        )}
      </td>
    </tr>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The top-bar button: rendered for instance admins only. */
export function AccessButton() {
  const [me, setMe] = useState<{ id: string; admin: boolean } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    getApi()
      .currentUser()
      .then((user) => {
        if (alive && user) setMe({ id: user.id, admin: user.globalRole === 'admin' });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!me?.admin) return null;
  return (
    <>
      <button
        type="button"
        className="btn btn--sm"
        title="Who can sign in, and what they can open"
        onClick={() => setOpen(true)}
      >
        Access
      </button>
      {open && <AccessScreen me={me.id} onClose={() => setOpen(false)} />}
    </>
  );
}

