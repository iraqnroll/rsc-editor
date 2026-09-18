import { useEffect, useRef, useState } from 'react';
import { getApi } from '../data/api.js';

/**
 * Download the project as a cache directory, or say exactly why not.
 *
 * The server only hands over a zip that it has re-imported and found identical
 * to the project (`exportWorld` in `@rsc-editor/cache`). When it refuses, the
 * list of problems is the useful part -- a sector and a tile to go and fix --
 * so it is shown in full rather than as "export failed".
 */
/**
 * Export (optionally as of a snapshot) and hand the zip to the browser.
 * Resolves to the refusal's problems, or null when a download started.
 */
export async function downloadExport(snapshotId?: string): Promise<string[] | null> {
  try {
    const outcome = await getApi().exportProject(snapshotId);
    if (!outcome.ok) return outcome.problems;
    const url = URL.createObjectURL(outcome.zip);
    const link = document.createElement('a');
    link.href = url;
    link.download = outcome.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoked on the next tick: some browsers start the download lazily.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return null;
  } catch (err) {
    return [`the export request failed: ${err instanceof Error ? err.message : String(err)}`];
  }
}

export function ExportButton() {
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[] | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setProblems(await downloadExport());
    setBusy(false);
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--sm"
        disabled={busy}
        title="Download this project as a cache directory (checked before download)"
        onClick={() => void run()}
      >
        {busy ? 'Exporting…' : 'Export'}
      </button>
      {problems && <ExportProblems problems={problems} onClose={() => setProblems(null)} />}
    </>
  );
}

export function ExportProblems({
  problems,
  onClose,
  title = 'Export refused',
  lead = 'The exported cache would not read back as this project, so nothing was downloaded.'
}: {
  problems: string[];
  onClose: () => void;
  title?: string;
  lead?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal__scrim" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__header">
          {title}
          <span className="spacer" />
          <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
            close
          </button>
        </div>
        <p className="hint">{lead}</p>
        <ul className="export-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
        {problems.some((p) => /scenery|wallsDiagonal|direction/.test(p)) && (
          <p className="hint">
            Scenery that doesn&apos;t cover its full footprint causes this. Claim the sectors listed
            above, then use <b>Scenery → Repair scenery in held sectors</b> and export again.
          </p>
        )}
      </div>
    </div>
  );
}
