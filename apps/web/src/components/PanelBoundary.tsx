/**
 * A panel that fails should not take the editor with it.
 *
 * React unmounts the entire tree when a render or an effect throws and nothing
 * catches it. For someone mid-session with unsaved local ops, losing the whole
 * window because a canvas panel hit a bad frame is the worst possible trade —
 * the ops live in the store, and the store lives in the tree.
 *
 * This is deliberately dumb: it shows what broke, offers a retry, and keeps
 * everything else alive.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface PanelBoundaryProps {
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class PanelBoundary extends Component<PanelBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}] panel crashed`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="empty" style={{ padding: 12 }}>
        <div style={{ color: 'var(--danger)' }}>{this.props.label} failed.</div>
        <div className="hint" style={{ margin: '4px 0 8px' }}>
          {error.message}
        </div>
        <button type="button" className="btn btn--sm" onClick={() => this.setState({ error: null })}>
          Retry
        </button>
      </div>
    );
  }
}
