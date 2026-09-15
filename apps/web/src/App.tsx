/**
 * Editor shell.
 *
 * Layout: top bar / [tool palette | viewport | inspector] / status bar.
 * Both side panes are resizable by pointer and by keyboard, and their widths
 * persist per browser so the layout you arranged is the one you come back to.
 */

import { useCallback, useEffect, useState } from 'react';
import { useEditor } from './state/editorStore.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { LoginGate, ProjectGate } from './components/Gate.js';
import { Inspector } from './components/Inspector.js';
import { Resizer } from './components/Resizer.js';
import { ShortcutsModal } from './components/ShortcutsModal.js';
import { StatusBar } from './components/StatusBar.js';
import { ToolPalette } from './components/ToolPalette.js';
import { ViewportHost } from './components/ViewportHost.js';
import { WorldMapModal } from './components/WorldMapModal.js';
import './styles.css';

const RAIL_MIN = 180;
const RAIL_MAX = 460;
const INSPECTOR_MIN = 260;
const INSPECTOR_MAX = 680;

function usePersistedWidth(key: string, initial: number): [number, (n: number) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = globalThis.localStorage?.getItem(key);
      return stored ? Number(stored) || initial : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (n: number) => {
      setValue(n);
      try {
        globalThis.localStorage?.setItem(key, String(n));
      } catch {
        /* private mode, blocked storage: the layout just does not persist */
      }
    },
    [key]
  );
  return [value, set];
}

export function App() {
  const connect = useEditor((s) => s.connect);
  const connection = useEditor((s) => s.connection);
  const error = useEditor((s) => s.error);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const undoDepth = useEditor((s) => s.undoStack.length);
  const redoDepth = useEditor((s) => s.redoStack.length);
  const apiMode = useEditor((s) => s.api.mode);
  const signOut = useEditor((s) => s.signOut);
  const chooseProject = useEditor((s) => s.chooseProject);
  const worldMapOpen = useEditor((s) => s.worldMapOpen);
  const setWorldMapOpen = useEditor((s) => s.setWorldMapOpen);

  const [railWidth, setRailWidth] = usePersistedWidth('rsc.rail', 252);
  const [inspectorWidth, setInspectorWidth] = usePersistedWidth('rsc.inspector', 352);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const openShortcuts = useCallback(() => setShowShortcuts(true), []);
  useKeyboard(openShortcuts);

  useEffect(() => {
    void connect();
  }, [connect]);

  // Neither of these is a failure: an anonymous first load and an account with
  // no project are both normal. Only `error` is red.
  if (connection === 'auth-required') return <LoginGate />;
  if (connection === 'no-project') return <ProjectGate />;
  if (connection === 'choose-project') return <ProjectGate mode="choose" />;

  if (connection === 'error') {
    return (
      <main style={{ padding: 32 }}>
        <h1>RSC Editor</h1>
        <p style={{ color: 'var(--danger)' }}>{error}</p>
        <button type="button" className="btn" onClick={() => void connect()}>
          Retry
        </button>
      </main>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar__brand">
          RSC<span>&middot;</span>EDITOR
        </span>
        <button type="button" className="btn btn--sm" disabled={undoDepth === 0} onClick={undo}>
          Undo
        </button>
        <button type="button" className="btn btn--sm" disabled={redoDepth === 0} onClick={redo}>
          Redo
        </button>
        <button
          type="button"
          className="btn btn--sm"
          title="Full-window world map (M)"
          onClick={() => setWorldMapOpen(true)}
        >
          Map
        </button>
        <span className="topbar__spacer" />
        <span className="hint">{apiMode === 'mock' ? 'mock backend' : 'live backend'}</span>
        {apiMode === 'live' && (
          <>
            <button
              type="button"
              className="btn btn--sm"
              title="Switch to another project"
              onClick={() => chooseProject()}
            >
              Projects
            </button>
            <button type="button" className="btn btn--sm" onClick={() => void signOut()}>
              Sign out
            </button>
          </>
        )}
      </header>

      <div className="workspace">
        <div style={{ width: railWidth, flex: `0 0 ${railWidth}px`, display: 'flex', minWidth: 0 }}>
          <ToolPalette />
        </div>
        <Resizer
          value={railWidth}
          onChange={setRailWidth}
          min={RAIL_MIN}
          max={RAIL_MAX}
          side="left"
          label="Resize tool palette"
        />

        <ViewportHost />

        <Resizer
          value={inspectorWidth}
          onChange={setInspectorWidth}
          min={INSPECTOR_MIN}
          max={INSPECTOR_MAX}
          side="right"
          label="Resize inspector"
        />
        <div
          style={{ width: inspectorWidth, flex: `0 0 ${inspectorWidth}px`, display: 'flex', minWidth: 0 }}
        >
          <Inspector />
        </div>
      </div>

      <StatusBar onShowShortcuts={openShortcuts} />

      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      {worldMapOpen && <WorldMapModal onClose={() => setWorldMapOpen(false)} />}
    </div>
  );
}
