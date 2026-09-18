import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RscConfig } from '@rsc-editor/schema';
import { exportConfig, loadConfig } from './config.js';

/**
 * New definitions made by copying an existing one -- a second coffin with its
 * own name, sharing the model -- must survive config85.jag: written at the end
 * of their table and read back.
 *
 * One field does not come back as sent: an object's `model.id`. It is not in
 * the archive; rsc-config rebuilds it from the model name table on load
 * (DECISIONS section 8), so a copy gets the id a fresh load assigns. That is
 * why the server stores a new row as it comes back out of the archive, and
 * why this test checks the property that relies on: once through, a row is
 * a fixed point.
 */

const original = new Uint8Array(readFileSync(join(__dirname, '../../../fixtures/data204/config85.jag')));
const config = loadConfig(original);

function withCopies(base: RscConfig, coffin: number): RscConfig {
  const edited = structuredClone(base);
  edited.objects.push({ ...base.objects[coffin]!, name: 'Old coffin', description: 'A different coffin' });
  edited.items.push({ ...base.items[10]!, name: 'Shiny coins', description: 'Not quite coins' });
  edited.npcs.push({ ...base.npcs[5]!, name: 'Hans jr', description: "Hans's nephew" });
  edited.wallObjects.push({ ...base.wallObjects[0]!, name: 'Old wall', description: 'Crumbling' });
  return edited;
}

describe('appended definitions', () => {
  const coffin = config.objects.findIndex((o) => /coffin/i.test(o.name));
  const edited = withCopies(config, coffin);
  const once = loadConfig(exportConfig(edited, original));

  it('come back for objects, items, NPCs and wall objects, everything else untouched', () => {
    expect(coffin).toBeGreaterThanOrEqual(0);
    const { model: sentModel, ...sent } = edited.objects.at(-1)!;
    const { model: gotModel, ...got } = once.objects.at(-1)!;
    expect(got).toEqual(sent);
    // The model is found by name; the name is what survives.
    expect(gotModel.name).toBe(sentModel.name);
    expect(once.items.at(-1)).toEqual(edited.items.at(-1));
    expect(once.npcs.at(-1)).toEqual(edited.npcs.at(-1));
    expect(once.wallObjects.at(-1)).toEqual(edited.wallObjects.at(-1));
    expect(once.objects.slice(0, -1)).toEqual(config.objects);
    expect(once.items.slice(0, -1)).toEqual(config.items);
  });

  it('lose any text that is not plain ASCII -- which is why the server refuses it', () => {
    const curly = structuredClone(config);
    curly.npcs.push({ ...config.npcs[5]!, description: 'Hans\u2019s nephew' });
    const back = loadConfig(exportConfig(curly, original));
    expect(back.npcs.at(-1)!.description).not.toBe('Hans\u2019s nephew');
  });

  it('are a fixed point once they have been through the archive', () => {
    const twice = loadConfig(exportConfig(once, original));
    expect(twice).toEqual(once);
  });
});
