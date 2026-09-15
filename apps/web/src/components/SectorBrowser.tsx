/**
 * The world panel in the left rail: plane picker, the coloured map, the legend,
 * and claim/release for the active sector.
 *
 * The map itself is `WorldMap`, which draws the importer's per-plane PNG with
 * the editor's own state on top and falls back to flat sector tiles when a
 * project has no imported cache. This file is only the surrounding controls —
 * which is why the same map can be dropped full-window with no changes.
 *
 * Lock colour is the holder's own presence colour, matching the tint and
 * nameplate in the viewport, so one person is one colour everywhere.
 */

import { useEffect, useState } from 'react';
import { MAX_PLANES, sectorKey } from '@rsc-editor/schema';
import { useEditor } from '../state/editorStore.js';
import { PanelBoundary } from './PanelBoundary.js';
import { Readout, Section } from './controls.js';
import { WorldMap } from './WorldMap.js';

const PLANE_LABELS = ['ground', 'floor 1', 'floor 2', 'dungeon'];

export function SectorBrowser() {
  const [plane, setPlane] = useState(0);

  const locks = useEditor((s) => s.locks);
  const me = useEditor((s) => s.me);
  const peers = useEditor((s) => s.peers);
  const activeSector = useEditor((s) => s.activeSector);
  const claimLock = useEditor((s) => s.claimLock);
  const releaseLock = useEditor((s) => s.releaseLock);
  const createSector = useEditor((s) => s.createSector);
  const world = useEditor((s) => s.world);
  const setWorldMapOpen = useEditor((s) => s.setWorldMapOpen);

  // The panel follows the active sector's plane: jumping to a dungeon sector
  // from anywhere else and then looking at a ground-floor map is a lie.
  useEffect(() => {
    if (activeSector && activeSector.plane !== plane) setPlane(activeSector.plane);
  }, [activeSector?.plane]);

  /**
   * A sector the project has no row for at all.
   *
   * Distinct from "not loaded": this one does not exist, cannot be locked, and
   * therefore cannot be edited until it is created. It is the normal state of
   * every coordinate in a project imported with `--no-landscape`.
   */
  const activeIsAbsent =
    !!activeSector && !!world && !world.present.includes(sectorKey(activeSector));

  const activeLock = activeSector ? locks[sectorKey(activeSector)] : undefined;
  const activeIsMine = !!activeLock && activeLock.userId === me?.userId;
  const activeOwnerColour = activeLock
    ? (activeLock.userId === me?.userId ? me?.colour : peers[activeLock.userId]?.colour) ?? '#f2b23e'
    : undefined;

  // The "expand" control lives in the map's own toolbar, not in the section
  // header: that header IS a button (it collapses the section), and a button
  // inside a button is invalid HTML.
  return (
    <Section title="World map">
      <div className="segmented" role="group" aria-label="Plane">
        {Array.from({ length: MAX_PLANES }, (_, p) => (
          <button key={p} type="button" aria-pressed={p === plane} onClick={() => setPlane(p)}>
            {PLANE_LABELS[p] ?? `plane ${p}`}
          </button>
        ))}
      </div>

      <PanelBoundary label="World map">
        <WorldMap plane={plane} height={232} onExpand={() => setWorldMapOpen(true)} />
      </PanelBoundary>

      <div className="legend">
        <span className="legend__item">
          <span className="swatch" style={{ background: me?.colour ?? '#4c9aff' }} /> yours
        </span>
        <span className="legend__item">
          <span className="swatch" style={{ background: '#f2b23e' }} /> held by someone
        </span>
        <span className="legend__item">
          <span
            className="swatch"
            style={{ background: 'transparent', borderColor: 'rgba(124,197,255,0.75)', borderStyle: 'dashed' }}
          />{' '}
          loaded
        </span>
        <span className="legend__item">
          <span className="swatch" style={{ background: '#7ce0a3' }} /> view
        </span>
        <span className="legend__item">
          <span className="swatch" style={{ background: '#0a0c0f' }} /> no data
        </span>
        <span className="legend__item" title="Where rsc-server puts arriving and respawning players">
          <span
            className="swatch"
            style={{ background: 'transparent', borderColor: '#ff5fa2', borderStyle: 'solid' }}
          />{' '}
          spawn
        </span>
      </div>

      <Readout
        label="Active"
        value={
          activeSector ? (
            <>
              {sectorKey(activeSector)}
              {activeLock && (
                <>
                  {' '}
                  <span className="dot" style={{ background: activeOwnerColour }} />{' '}
                  {activeIsMine ? 'yours' : activeLock.displayName}
                </>
              )}
            </>
          ) : (
            'none'
          )
        }
      />

      <div className="field__row">
        {activeIsAbsent ? (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            title="This sector does not exist yet. Create it empty, then claim it to edit."
            onClick={() => activeSector && void createSector(activeSector)}
          >
            Create sector
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={!activeSector || activeIsMine}
            onClick={() => activeSector && void claimLock(activeSector)}
          >
            Claim
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm"
          disabled={!activeIsMine}
          onClick={() => activeSector && void releaseLock(activeSector)}
        >
          Release
        </button>
        {activeIsAbsent && <span className="hint">no data here yet</span>}
        {activeLock && !activeIsMine && (
          <span className="hint">read-only — held by {activeLock.displayName}</span>
        )}
      </div>
    </Section>
  );
}
