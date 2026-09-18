/**
 * Global keybindings.
 *
 * Mapping is a two-handed activity: left hand on the tool/radius keys, right
 * hand on the pointer. Everything here is reachable without leaving the
 * viewport, and nothing fires while a text field has focus.
 */

import { useEffect } from 'react';
import { useEditor } from '../state/editorStore.js';
import { copySelection } from '../state/gesture.js';
import { TOOLS } from '../tools/registry.js';

export interface Shortcut {
  keys: string;
  description: string;
}

export const SHORTCUTS: Shortcut[] = [
  ...TOOLS.map((t) => ({ keys: t.hotkey, description: `${t.label} tool` })),
  { keys: '[  ]', description: 'Brush radius smaller / larger' },
  { keys: '-  =', description: 'Brush strength down / up (elevation)' },
  { keys: 'Alt + drag', description: 'Invert the active tool (lower, erase, delete)' },
  { keys: 'Shift + drag', description: 'Pan the viewport' },
  { keys: 'Middle drag', description: 'Pan the viewport' },
  { keys: 'Wheel', description: 'Zoom around the cursor' },
  { keys: 'Ctrl + Z', description: 'Undo (your ops only)' },
  { keys: 'Ctrl + Shift + Z', description: 'Redo' },
  { keys: 'Ctrl + C', description: 'Copy the region selection' },
  { keys: 'C', description: 'Claim the active sector' },
  { keys: 'R', description: 'Release the active sector' },
  { keys: 'G', description: 'Toggle the tile grid' },
  { keys: 'B', description: 'Toggle sector borders' },
  { keys: 'L', description: 'Toggle lock ownership tint' },
  { keys: 'M', description: 'Full-window world map' },
  { keys: 'Esc', description: 'Dismiss a message / clear the selection' },
  { keys: '?', description: 'This sheet' }
];

function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
  );
}

export function useKeyboard(onShowShortcuts: () => void): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (inTextField(e.target)) return;
      const store = useEditor.getState();

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        store.redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        if (store.selection) {
          e.preventDefault();
          copySelection();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const tool = TOOLS.find((t) => t.hotkey === e.key);
      if (tool) {
        e.preventDefault();
        store.setTool(tool.id);
        return;
      }

      switch (e.key) {
        case '[':
        case ']': {
          const delta = e.key === '[' ? -1 : 1;
          const t = store.activeTool;
          if (t === 'elevation') {
            store.updateToolSettings('elevation', {
              radius: clamp(store.toolSettings.elevation.radius + delta, 0, 16)
            });
          } else if (t === 'paint') {
            store.updateToolSettings('paint', {
              radius: clamp(store.toolSettings.paint.radius + delta, 0, 12)
            });
          } else if (t === 'roof' || t === 'hole' || t === 'eraser') {
            store.updateToolSettings(t, {
              radius: clamp(store.toolSettings[t].radius + delta, 0, 12)
            });
          }
          e.preventDefault();
          break;
        }
        case '-':
        case '=': {
          if (store.activeTool !== 'elevation') break;
          const delta = e.key === '-' ? -0.05 : 0.05;
          store.updateToolSettings('elevation', {
            strength: clamp(round2(store.toolSettings.elevation.strength + delta), 0.05, 1)
          });
          e.preventDefault();
          break;
        }
        case 'c':
        case 'C':
          if (store.activeSector) void store.claimLock(store.activeSector);
          break;
        case 'r':
        case 'R':
          if (store.activeSector) void store.releaseLock(store.activeSector);
          break;
        case 'g':
        case 'G':
          store.toggleOverlay('showGrid');
          break;
        case 'b':
        case 'B':
          store.toggleOverlay('showSectorBorders');
          break;
        case 'l':
        case 'L':
          store.toggleOverlay('showLockTint');
          break;
        case 'm':
        case 'M':
          store.setWorldMapOpen(!store.worldMapOpen);
          break;
        case 'Escape':
          if (store.notice) store.setNotice(null);
          else store.setSelection(null);
          break;
        case '?':
          onShowShortcuts();
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onShowShortcuts]);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
