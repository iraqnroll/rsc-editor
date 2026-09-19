import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WalkTag } from './DefPicker.js';

const tag = (kind: string, entry: Record<string, unknown>) => renderToStaticMarkup(<WalkTag kind={kind} entry={entry} />);

describe('WalkTag', () => {
  it('flags what players cannot walk through, and what they can despite looks', () => {
    expect(tag('tiles', { type: 'ground', blocked: true })).toContain('>blocked<');
    expect(tag('tiles', { type: 'floor', blocked: false })).toBe('');
    expect(tag('objects', { type: 'closed-door' })).toContain('>closed door<');
    expect(tag('objects', { type: 'open-door' })).toContain('>open door<');
    expect(tag('objects', { type: 'blocked' })).toBe('');
    expect(tag('wallObjects', { name: 'Doorframe', blocked: false })).toContain('>walk-through<');
    expect(tag('wallObjects', { name: 'Wall', blocked: true })).toBe('');
  });
});
