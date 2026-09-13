/**
 * World overview + jump-to-sector, with lock ownership shown per sector.
 *
 * This is the navigation surface for a 65 x 56 x 4 world, so it has to answer
 * "where am I, what is claimable, and who has what" at a glance. Lock colour is
 * the peer's own presence colour, matching the tint and nameplate in the
 * viewport, so the same person is the same colour everywhere.
 *
 * PLACEHOLDER: the cells are flat lock/presence state. The real thing renders
 * `landscape.toCanvas()` terrain thumbnails underneath (PLAN.md); that image
 * comes from the cache/render side, and this component only needs a per-sector
 * bitmap to draw beneath the same overlay.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  MIN_REGION_X,
  MIN_REGION_Y,
  sectorKey
} from '@rsc-editor/schema';
import type { SectorCoord } from '@rsc-editor/schema';
import { lockStateFor, useEditor } from '../state/editorStore.js';
import { Readout, Section } from './controls.js';

const X0 = MIN_REGION_X;
const Y0 = MIN_REGION_Y;
const COLS = MAX_X_SECTORS - X0;
const ROWS = MAX_Y_SECTORS - Y0;

export function SectorBrowser() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [plane, setPlane] = useState(0);
  const [hover, setHover] = useState<SectorCoord | null>(null);

  const world = useEditor((s) => s.world);
  const locks = useEditor((s) => s.locks);
  const peers = useEditor((s) => s.peers);
  const me = useEditor((s) => s.me);
  const sectors = useEditor((s) => s.sectors);
  const activeSector = useEditor((s) => s.activeSector);
  const setActiveSector = useEditor((s) => s.setActiveSector);
  const claimLock = useEditor((s) => s.claimLock);
  const releaseLock = useEditor((s) => s.releaseLock);

  useEffect(() => {
    if (activeSector && activeSector.plane !== plane) setPlane(activeSector.plane);
  }, [activeSector?.plane]);

  const cell = 10;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = COLS * cell * dpr;
    canvas.height = ROWS * cell * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, COLS * cell, ROWS * cell);

    for (let x = 0; x < COLS; x++) {
      for (let y = 0; y < ROWS; y++) {
        const coord = { plane, x: X0 + x, y: Y0 + y };
        const key = sectorKey(coord);
        const px = x * cell;
        const py = y * cell;

        const { state, lock } = lockStateFor({ locks, me, world }, coord);
        let fill = '#0d0f12';
        if (state === 'absent') {
          fill = '#0a0c0f';
        } else if (state === 'mine') {
          fill = me?.colour ?? '#4c9aff';
        } else if (state === 'theirs') {
          fill = (lock && peers[lock.userId]?.colour) ?? '#f2b23e';
        } else {
          fill = sectors[key] ? '#333a47' : '#20242c';
        }
        ctx.fillStyle = fill;
        ctx.fillRect(px, py, cell - 1, cell - 1);

        if (world?.members[key]) {
          ctx.fillStyle = 'rgba(242, 178, 62, 0.28)';
          ctx.fillRect(px, py, 3, 3);
        }

        if (activeSector && activeSector.plane === plane && activeSector.x === coord.x && activeSector.y === coord.y) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(px + 0.5, py + 0.5, cell - 2, cell - 2);
        }
      }
    }
  }, [plane, locks, peers, me, world, sectors, activeSector]);

  const hoverInfo = useMemo(() => {
    if (!hover) return null;
    const { state, lock } = lockStateFor({ locks, me, world }, hover);
    return { key: sectorKey(hover), state, owner: lock?.displayName ?? null };
  }, [hover, locks, me, world]);

  const activeLock = activeSector ? locks[sectorKey(activeSector)] : undefined;
  const activeIsMine = !!activeLock && activeLock.userId === me?.userId;

  function pick(e: {
    currentTarget: HTMLCanvasElement;
    clientX: number;
    clientY: number;
  }): SectorCoord | null {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * COLS);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * ROWS);
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return null;
    return { plane, x: X0 + x, y: Y0 + y };
  }

  return (
    <Section title="World / sectors">
      <div className="segmented" role="group" aria-label="Plane">
        {Array.from({ length: MAX_PLANES }, (_, p) => (
          <button key={p} type="button" aria-pressed={p === plane} onClick={() => setPlane(p)}>
            {p === 0 ? 'ground' : p === 3 ? 'dungeon' : `floor ${p}`}
          </button>
        ))}
      </div>

      <canvas
        ref={canvasRef}
        className="minimap"
        style={{ aspectRatio: `${COLS} / ${ROWS}` }}
        tabIndex={0}
        role="application"
        aria-label="Sector overview — click to jump"
        onPointerMove={(e) => setHover(pick(e))}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const coord = pick(e);
          if (coord) setActiveSector(coord);
        }}
        onKeyDown={(e) => {
          if (!activeSector) return;
          const d =
            e.key === 'ArrowLeft'
              ? [-1, 0]
              : e.key === 'ArrowRight'
                ? [1, 0]
                : e.key === 'ArrowUp'
                  ? [0, -1]
                  : e.key === 'ArrowDown'
                    ? [0, 1]
                    : null;
          if (!d) return;
          e.preventDefault();
          setActiveSector({
            plane,
            x: Math.max(0, Math.min(MAX_X_SECTORS - 1, activeSector.x + (d[0] ?? 0))),
            y: Math.max(0, Math.min(MAX_Y_SECTORS - 1, activeSector.y + (d[1] ?? 0)))
          });
        }}
      />

      <div className="legend">
        <span className="legend__item">
          <span className="swatch" style={{ background: '#20242c' }} /> free
        </span>
        <span className="legend__item">
          <span className="swatch" style={{ background: '#333a47' }} /> loaded
        </span>
        <span className="legend__item">
          <span className="swatch" style={{ background: me?.colour ?? '#4c9aff' }} /> yours
        </span>
        <span className="legend__item">
          <span className="swatch" style={{ background: '#f2b23e' }} /> held by someone
        </span>
        <span className="legend__item">
          <span className="swatch" style={{ background: '#0a0c0f' }} /> no data
        </span>
      </div>

      <Readout
        label="Hover"
        value={
          hoverInfo
            ? `${hoverInfo.key} — ${hoverInfo.state}${hoverInfo.owner ? ` (${hoverInfo.owner})` : ''}`
            : '—'
        }
      />

      <Readout label="Active" value={activeSector ? sectorKey(activeSector) : 'none'} />

      <div className="field__row">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={!activeSector || activeIsMine}
          onClick={() => activeSector && void claimLock(activeSector)}
        >
          Claim
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={!activeIsMine}
          onClick={() => activeSector && void releaseLock(activeSector)}
        >
          Release
        </button>
        {activeLock && !activeIsMine && (
          <span className="hint">held by {activeLock.displayName}</span>
        )}
      </div>
    </Section>
  );
}
