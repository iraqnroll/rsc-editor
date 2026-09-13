/**
 * Render smoke tests.
 *
 * No DOM environment is installed in this workspace, so these render to a
 * string. That does not exercise effects or pointer handling, but it catches
 * the failure mode `tsc` cannot see: a component that throws on first render
 * because of a bad import, a missing null guard, or a selector that assumed
 * loaded data.
 *
 * Note for anyone extending this: under `renderToString`, zustand serves
 * `getInitialState()`, not the current store state, so seeding the store and
 * rendering <App/> will always show the empty shell. Components that need
 * seeded data are therefore tested through their props — which they all take,
 * because the store-connected wrappers are deliberately thin.
 */

import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { definitionSchemas, emptySectorBuffers, sectorKey } from '@rsc-editor/schema';
import type { DefinitionKind } from '@rsc-editor/schema';
import { App } from './App.js';
import { createMockApi } from './data/mock-api.js';
import { ColourField } from './defs/ColourField.js';
import { SchemaForm } from './defs/SchemaForm.js';
import { introspectObject } from './defs/zod-introspect.js';
import { Viewport } from './scene/Viewport.js';

describe('editor shell', () => {
  it('renders the whole shell without throwing', () => {
    const html = renderToString(<App />);
    expect(html).toContain('class="app"');
    expect(html).toContain('Tools');
    expect(html).toContain('statusbar');
    // Mock data must be labelled, not silently passed off as real.
    expect(html).toContain('mock data');
    // All seven tools are present.
    for (const label of ['Select', 'Elevation', 'Paint', 'Walls', 'Roof', 'Scenery', 'Region']) {
      expect(html).toContain(`>${label}</span>`);
    }
    // The renderer seam is labelled so nobody mistakes it for the real viewport.
    expect(html).toContain('2D placeholder viewport');
  });
});

describe('viewport seam', () => {
  it('renders from props alone, with a peer-held sector', () => {
    const a = { plane: 0, x: 50, y: 50 };
    const buffers = emptySectorBuffers();
    buffers.elevation.fill(100);

    const html = renderToString(
      <Viewport
        plane={0}
        sectors={{ [sectorKey(a)]: { coord: a, buffers, rev: 0 } }}
        activeSector={a}
        lockFor={() => ({ state: 'theirs', ownerName: 'mudlark', ownerColour: '#f2b23e' })}
        hoverTile={{ plane: 0, wx: 2410, wy: 2410 }}
        selection={null}
        brushRadius={3}
        brushShape="circle"
        showGrid
        showSectorBorders
        showLockTint
        painting
        regionDrag={false}
        onPick={() => {}}
        onHover={() => {}}
        onDragRegion={() => {}}
      />
    );
    expect(html).toContain('<canvas');
    expect(html).toContain('px/tile');
  });
});

describe('generated definition forms', () => {
  it('renders a form for every one of the ten kinds, against real-shaped data', async () => {
    const api = createMockApi();
    const config = await api.loadConfig();
    api.disconnect();
    const lists = config as unknown as Record<string, Array<Record<string, unknown>>>;

    for (const kind of Object.keys(definitionSchemas) as DefinitionKind[]) {
      const fields = introspectObject(definitionSchemas[kind]);
      const entry = lists[kind]?.[0];
      expect(entry, kind).toBeDefined();
      const html = renderToString(
        <SchemaForm fields={fields} value={entry!} onChange={() => {}} />
      );
      expect(html.length, kind).toBeGreaterThan(0);
      // Every field must produce a real control, never an empty shell.
      expect(html, kind).toContain('class="field"');
    }
  });

  it('renders "none" for a null field rather than an empty control', async () => {
    const api = createMockApi();
    const config = await api.loadConfig();
    api.disconnect();

    // items[0] has equip === null and colour === null in the mock, mirroring
    // the 949/1290 and 461/1290 counts in the real cache.
    const item = config.items[0]!;
    expect(item.equip).toBeNull();
    expect(item.colour).toBeNull();

    const html = renderToString(
      <SchemaForm
        fields={introspectObject(definitionSchemas.items)}
        value={item as unknown as Record<string, unknown>}
        onChange={() => {}}
      />
    );
    expect(html).toContain('nullable__none');
    expect(html).toContain('>none<');
    expect(html).toContain('>set</button>');
  });

  it('offers transparent as a first-class colour mode', async () => {
    const html = renderToString(
      <SchemaForm
        fields={introspectObject(definitionSchemas.tiles)}
        value={{ colour: 'transparent', texture: null, type: 'hole', blocked: true }}
        onChange={() => {}}
      />
    );
    expect(html).toContain('transparent');
    expect(html).toContain('transparent-preview');
  });

  it('renders objects[581] with its real 0x0 footprint', async () => {
    const api = createMockApi();
    const config = await api.loadConfig();
    api.disconnect();

    const obj = config.objects[581]!;
    expect(obj.width).toBe(0);
    const html = renderToString(
      <SchemaForm
        fields={introspectObject(definitionSchemas.objects)}
        value={obj as unknown as Record<string, unknown>}
        onChange={() => {}}
      />
    );
    expect(html).toContain('value="0"');
  });
});

describe('colour control', () => {
  it('renders all three states and only offers "none" when nullable', () => {
    const nullState = renderToString(
      <ColourField value={null} nullable onChange={() => {}} />
    );
    expect(nullState).toContain('>none</button>');
    expect(nullState).toContain('no colour override');

    const transparentState = renderToString(
      <ColourField value="transparent" nullable onChange={() => {}} />
    );
    expect(transparentState).toContain('transparent-preview');
    expect(transparentState).toContain('hole');

    const rgbState = renderToString(
      <ColourField value="rgb(238, 221, 221)" nullable onChange={() => {}} />
    );
    expect(rgbState).toContain('type="color"');
    expect(rgbState).toContain('#eedddd');
    expect(rgbState).toContain('value="238"');

    // animations.colour is not nullable: no "none" escape hatch.
    const nonNullable = renderToString(
      <ColourField value="rgb(0, 0, 0)" nullable={false} onChange={() => {}} />
    );
    expect(nonNullable).not.toContain('>none</button>');
    expect(nonNullable).toContain('transparent');
  });
});
