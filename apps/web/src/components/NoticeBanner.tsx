/**
 * The one place edits get refused, and it always says why and what to do.
 *
 * The important case is `lock-required`: a brush stroke that spilled into a
 * sector you do not hold. The spill is NOT silently dropped and it is NOT
 * half-applied — the whole stroke is held pending, and one click either claims
 * the sectors and replays it, or discards it.
 */

import { sectorKey } from '@rsc-editor/schema';
import { useEditor } from '../state/editorStore.js';

export function NoticeBanner() {
  const notice = useEditor((s) => s.notice);
  const resolveNotice = useEditor((s) => s.resolveNotice);
  const setNotice = useEditor((s) => s.setNotice);

  if (!notice) return null;

  if (notice.kind === 'lock-required') {
    const names = notice.sectors.map((c) => sectorKey(c));
    const takenBy = Object.entries(notice.heldBy);
    return (
      <div className="viewport__overlay">
        <div className="banner" role="alert">
          <span className="banner__icon" aria-hidden="true">
            &#9888;
          </span>
          <span style={{ flex: 1 }}>
            <strong>{notice.label}</strong> reaches {names.length === 1 ? 'sector' : 'sectors'}{' '}
            <code>{names.join(', ')}</code>, which you do not hold.
            {takenBy.length > 0 && (
              <>
                {' '}
                {takenBy.map(([key, who]) => `${key} is held by ${who}`).join('; ')}.
              </>
            )}
          </span>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={takenBy.length > 0}
            onClick={() => void resolveNotice('claim')}
          >
            Claim {names.length === 1 ? 'sector' : 'sectors'}
          </button>
          <button type="button" className="btn btn--sm" onClick={() => void resolveNotice('dismiss')}>
            Discard
          </button>
        </div>
      </div>
    );
  }

  const text =
    notice.kind === 'conflict'
      ? notice.messages.join(' ')
      : notice.kind === 'loading'
        ? `Loading ${notice.sectors.length} sector(s) the edit reaches — try again in a moment.`
        : notice.message;

  return (
    <div className="viewport__overlay">
      <div
        className="banner"
        role={notice.kind === 'error' ? 'alert' : 'status'}
        style={
          notice.kind === 'error'
            ? { borderColor: 'var(--danger)', background: 'rgba(30, 16, 16, 0.95)' }
            : undefined
        }
      >
        <span className="banner__icon" aria-hidden="true">
          {notice.kind === 'error' ? '✖' : 'ℹ'}
        </span>
        <span style={{ flex: 1 }}>{text}</span>
        <button type="button" className="btn btn--sm" onClick={() => setNotice(null)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
