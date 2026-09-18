import { describe, expect, it } from 'vitest';
import { textProblem, unencodableText } from './archive-text.js';

describe('text a definition can hold', () => {
  it('is printable ASCII, found wherever it is nested', () => {
    expect(unencodableText({ name: 'Coffin', commands: ['Open', 'Search'] })).toBeNull();
    expect(unencodableText({ name: 'Kosmolit', commands: ['Open', 'Užverti'] })).toEqual({ path: 'commands[1]', char: 'ž' });
    expect(unencodableText({ model: { name: 'coffin\n' } })).toEqual({ path: 'model.name', char: '\n' });
  });

  it('says what to do instead', () => {
    expect(textProblem({ description: 'Hans’s nephew' })).toMatch(/description contains ".*typographic quote; use '/);
    expect(textProblem({ name: '£5' })).toMatch(/name contains "£"/);
    expect(textProblem({ name: 'Plain' })).toBeNull();
  });
});
