import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnimationDef, LibraryKind, TextureDef } from '@rsc-editor/schema';
import { isApiHttpError } from '../data/http.js';
import {
  addDefinition,
  deleteAsset,
  deleteDefinition,
  downloadAsset,
  hasLibrary,
  listLibrary,
  moveDefinition,
  moveItemSprite,
  previewUrl,
  renameModel,
  uploadAsset,
  type LibraryItem,
  type LibraryTable,
  type UploadOptions
} from '../data/library.js';
import { ModelThumbnail } from '../scene/ModelThumbnail.js';
import { useEditor } from '../state/editorStore.js';

/**
 * The asset library: the project's models, texture images, NPC sprites and
 * item sprites, with what uses each one.
 *
 * Browse, download, add, replace, rename, reorder and delete -- not edit. Every
 * change goes to the server, which rewrites whatever referred to the asset
 * (item sprite numbers, texture numbers in walls, tiles, roofs and model faces,
 * NPC animation slots, object model names) and refuses to delete anything
 * still in use. Everyone with the project open sees the result.
 */

type Tab = 'models' | 'textures' | 'npcs' | 'items';

const TABS: Array<[Tab, string]> = [
  ['models', 'Models'],
  ['textures', 'Textures'],
  ['npcs', 'NPC sprites'],
  ['items', 'Item sprites']
];

export function AssetsButton() {
  const [open, setOpen] = useState(false);
  const connection = useEditor((s) => s.connection);
  if (connection !== 'ready') return null;
  return (
    <>
      <button
        type="button"
        className="btn btn--sm"
        title="Browse, add, replace, reorder and delete models, textures and sprites"
        onClick={() => setOpen(true)}
      >
        Assets
      </button>
      {open && <AssetsScreen onClose={() => setOpen(false)} />}
    </>
  );
}

export function AssetsScreen({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>('models');
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    ref.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Run a change and report how it went. */
  const act = useCallback(async (change: () => Promise<string | void>): Promise<boolean> => {
    try {
      const done = await change();
      setNotice(done ? { kind: 'info', text: done } : null);
      return true;
    } catch (err) {
      setNotice({ kind: 'error', text: describe(err) });
      return false;
    }
  }, []);

  return (
    <div className="modal__scrim" onClick={onClose} role="presentation">
      <div
        className="modal modal--assets"
        role="dialog"
        aria-modal="true"
        aria-label="Assets"
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__header">
          Assets
          <span className="spacer" />
          <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
            close
          </button>
        </div>
        <div className="tabs" role="tablist" aria-label="Asset kind">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        {notice && (
          <p className={notice.kind === 'error' ? 'gate__error assets__notice' : 'hint assets__notice'} role="alert">
            {notice.text}
          </p>
        )}
        {!hasLibrary() ? (
          <p className="hint assets__intro">The asset library needs the live backend.</p>
        ) : (
          <div className="assets__body">
            {tab === 'models' && <ModelsTab act={act} />}
            {tab === 'textures' && <TexturesTab act={act} />}
            {tab === 'npcs' && <NpcSpritesTab act={act} />}
            {tab === 'items' && <ItemSpritesTab act={act} />}
          </div>
        )}
      </div>
    </div>
  );
}

type Act = (change: () => Promise<string | void>) => Promise<boolean>;

/* ------------------------------------------------------------------ data -- */

/** A library kind's entries, refetched whenever the library changes. */
function useLibrary(kind: LibraryKind) {
  const version = useEditor((s) => s.libraryVersion);
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    listLibrary(kind).then(
      (list) => {
        if (alive) {
          setItems(list);
          setError(null);
        }
      },
      (err: unknown) => alive && setError(describe(err))
    );
    return () => {
      alive = false;
    };
  }, [kind, version, tick]);
  return { items, error, reload: () => setTick((t) => t + 1) };
}

function useFilter<T>(items: readonly T[] | null, text: (item: T) => string) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((item) => !q || text(item).toLowerCase().includes(q));
  }, [items, query, text]);
  return { query, setQuery, shown };
}

/* ----------------------------------------------------------------- models -- */

function ModelsTab({ act }: { act: Act }) {
  const { items, error, reload } = useLibrary('model');
  const text = useCallback((m: LibraryItem) => m.key, []);
  const { query, setQuery, shown } = useFilter(items, text);
  const version = useEditor((s) => s.libraryVersion);
  const [name, setName] = useState('');
  const [scale, setScale] = useState(128);

  async function add(files: FileList | null, key: string) {
    const main = [...(files ?? [])].find((f) => /\.(ob3|obj)$/i.test(f.name));
    if (!main) return;
    const mtl = [...(files ?? [])].find((f) => /\.mtl$/i.test(f.name)) ?? null;
    const format = /\.obj$/i.test(main.name) ? 'obj' : 'ob3';
    const target = (key || main.name.replace(/\.(ob3|obj)$/i, '')).toLowerCase();
    if (await act(async () => summary(target, await uploadAsset('model', target, { main, mtl }, { format, scale })))) {
      setName('');
      reload();
    }
  }

  return (
    <>
      <p className="hint assets__intro">
        Objects draw models by name. Upload <code>.ob3</code>, or <code>.obj</code> with its{' '}
        <code>.mtl</code> (select both): one unit is one tile, a material&apos;s <code>Kd</code> is
        its colour, <code>texture_N</code> uses texture N, <code>_2s</code> draws both sides.
        Uploading onto an existing name replaces it everywhere it is used.
      </p>
      <div className="assets__bar">
        <input type="search" aria-label="Filter models" placeholder="filter" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="spacer" />
        <input type="text" aria-label="New model name" placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="assets__inline">
          scale
          <input
            aria-label="OBJ scale"
            type="number"
            value={scale}
            min={1}
            onChange={(e) => setScale(Math.max(1, Number(e.target.value) || 128))}
            title="model units per OBJ unit; 128 = one tile"
          />
        </label>
        <FilePick label="Add model…" accept=".ob3,.obj,.mtl" multiple onPick={(f) => add(f, name.trim())} />
      </div>
      <Status items={items} error={error} count={shown.length} />
      <div className="assets__grid">
        {shown.map((m) => (
          <div key={m.key} className="asset">
            <ModelThumbnail modelName={m.key} size={96} version={version} />
            <div className="asset__name" title={m.key}>
              {m.key}
            </div>
            <div className="asset__meta">
              {m.meta.faces} faces · {m.meta.vertices} verts
            </div>
            <UsedBy uses={m.usedBy} />
            <div className="asset__actions">
              <FilePick label="Replace" accept=".ob3,.obj,.mtl" multiple onPick={(f) => add(f, m.key)} />
              <button type="button" className="btn btn--sm" onClick={() => act(() => downloadAsset('model', m.key, 'ob3'))}>
                .ob3
              </button>
              <button type="button" className="btn btn--sm" onClick={() => act(() => downloadAsset('model', m.key, 'obj'))}>
                .obj
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  const to = window.prompt(`Rename "${m.key}" to`, m.key)?.trim();
                  if (to && to !== m.key) void act(async () => (await renameModel(m.key, to), `Renamed ${m.key} to ${to}.`)).then(reload);
                }}
              >
                Rename
              </button>
              <DeleteButton
                uses={m.usedBy}
                onDelete={() => act(async () => (await deleteAsset('model', m.key), `Deleted ${m.key}.`)).then(reload)}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* --------------------------------------------------------------- textures -- */

function TexturesTab({ act }: { act: Act }) {
  const { items, error, reload } = useLibrary('textureImage');
  const textures = useEditor((s) => s.config?.textures ?? []);
  const config = useEditor((s) => s.config);
  const text = useCallback((m: LibraryItem) => m.key, []);
  const { query, setQuery, shown } = useFilter(items, text);
  const [name, setName] = useState('');
  const byKey = useMemo(() => new Map((items ?? []).map((i) => [i.key, i])), [items]);

  /** Walls, tiles and roofs that use texture i; models are checked by the server. */
  const users = useCallback(
    (i: number) => {
      if (!config) return 0;
      return (
        config.wallObjects.filter((w) => w.textureFront === i || w.textureBack === i).length +
        config.tiles.filter((t) => t.texture === i).length +
        config.roofs.filter((r) => r.texture === i).length
      );
    },
    [config]
  );

  async function upload(files: FileList | null, key: string) {
    const main = files?.[0];
    if (!main) return;
    const target = (key || main.name.replace(/\.png$/i, '')).toLowerCase();
    if (await act(async () => summary(target, await uploadAsset('textureImage', target, { main })))) {
      setName('');
      reload();
    }
  }

  return (
    <>
      <p className="hint assets__intro">
        Walls, floors, roofs and model faces use a texture by its <b>number</b>. A texture is an
        image, optionally with an overlay image drawn on top. Moving a texture renumbers everything
        that uses it. Images are 64×64 or 128×128 PNGs; pure green in an overlay cuts a hole.
      </p>
      <h3 className="assets__heading">Texture numbers</h3>
      <DefinitionTable<TextureDef>
        kind="textures"
        rows={textures}
        act={act}
        columns={[
          ['image', (t) => <ImageThumb kind="textureImage" item={byKey.get(t.name.toLowerCase())} size={32} />],
          ['name', (t) => t.name],
          ['overlay', (t) => t.subName || '—'],
          ['used by', (_, i) => `${users(i)} + models`]
        ]}
        blank={() => ({ name: [...byKey.keys()][0] ?? 'wall', subName: '' })}
        newLabel="Add texture"
        describeNew={(t) => `image "${t.name}"`}
        pickNew={(current) => {
          const image = window.prompt('Image for the new texture', current.name)?.trim().toLowerCase();
          if (!image) return null;
          const overlay = window.prompt('Overlay image (empty for none)', '')?.trim().toLowerCase() ?? '';
          return { name: image, subName: overlay };
        }}
      />

      <h3 className="assets__heading">Images</h3>
      <div className="assets__bar">
        <input type="search" aria-label="Filter images" placeholder="filter" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="spacer" />
        <input type="text" aria-label="New image name" placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <FilePick label="Add image…" accept=".png" onPick={(f) => upload(f, name.trim())} />
      </div>
      <Status items={items} error={error} count={shown.length} />
      <div className="assets__grid">
        {shown.map((m) => (
          <div key={m.key} className="asset">
            <ImageThumb kind="textureImage" item={m} size={96} />
            <div className="asset__name">{m.key}</div>
            <div className="asset__meta">
              {m.meta.width}×{m.meta.height}
            </div>
            <UsedBy uses={m.usedBy} />
            <div className="asset__actions">
              <FilePick label="Replace" accept=".png" onPick={(f) => upload(f, m.key)} />
              <button type="button" className="btn btn--sm" onClick={() => act(() => downloadAsset('textureImage', m.key, 'png'))}>
                .png
              </button>
              <DeleteButton
                uses={m.usedBy}
                onDelete={() => act(async () => (await deleteAsset('textureImage', m.key), `Deleted ${m.key}.`)).then(reload)}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------ NPC sprites -- */

function NpcSpritesTab({ act }: { act: Act }) {
  const { items, error, reload } = useLibrary('spriteSet');
  const animations = useEditor((s) => s.config?.animations ?? []);
  const npcs = useEditor((s) => s.config?.npcs ?? []);
  const text = useCallback((m: LibraryItem) => m.key, []);
  const { query, setQuery, shown } = useFilter(items, text);
  const [name, setName] = useState('');
  const [rows, setRows] = useState<1 | 2 | 3>(2);
  const [members, setMembers] = useState(false);
  const byKey = useMemo(() => new Map((items ?? []).map((i) => [i.key, i])), [items]);

  async function upload(files: FileList | null, key: string, options: UploadOptions) {
    const main = files?.[0];
    if (!main) return;
    const target = (key || main.name.replace(/\.png$/i, '')).toLowerCase();
    if (await act(async () => summary(target, await uploadAsset('spriteSet', target, { main }, options)))) {
      setName('');
      reload();
    }
  }

  return (
    <>
      <p className="hint assets__intro">
        NPCs use up to 12 <b>animation numbers</b>; an animation names a sprite set. A sprite set
        is one PNG, 15 cells wide: row 1 the 15 walk/stand frames, row 2 the 3 attack frames, row 3
        the 9 fight frames. The 204 client has room for about a dozen more full sets.
      </p>
      <h3 className="assets__heading">Animation numbers</h3>
      <DefinitionTable<AnimationDef>
        kind="animations"
        rows={animations}
        act={act}
        columns={[
          ['sprites', (a) => <ImageThumb kind="spriteSet" item={byKey.get(a.name.toLowerCase())} size={32} crop />],
          ['name', (a) => a.name],
          ['frames', (a) => `walk${a.hasA ? ' + attack' : ''}${a.hasF ? ' + fight' : ''}`],
          ['used by', (_, i) => `${npcs.filter((n) => n.animations.includes(i)).length} NPCs`]
        ]}
        blank={() => ({ name: [...byKey.keys()][0] ?? 'man', colour: 'rgb(255, 255, 255)', genderModel: 0, hasA: false, hasF: false })}
        newLabel="Add animation"
        describeNew={(a) => `sprites "${a.name}"`}
        pickNew={(current) => {
          const sprites = window.prompt('Sprite set for the new animation', current.name)?.trim().toLowerCase();
          if (!sprites) return null;
          const meta = byKey.get(sprites)?.meta;
          return { ...current, name: sprites, hasA: meta?.attack === true, hasF: meta?.fight === true };
        }}
      />

      <h3 className="assets__heading">Sprite sets</h3>
      <div className="assets__bar">
        <input type="search" aria-label="Filter sprite sets" placeholder="filter" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="spacer" />
        <input type="text" aria-label="New sprite set name" placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="assets__inline">
          rows
          <select aria-label="Sheet rows" value={rows} onChange={(e) => setRows(Number(e.target.value) as 1 | 2 | 3)}>
            <option value={1}>walk</option>
            <option value={2}>walk + attack</option>
            <option value={3}>walk + attack + fight</option>
          </select>
        </label>
        <label className="assets__inline">
          <input type="checkbox" checked={members} onChange={(e) => setMembers(e.target.checked)} /> members
        </label>
        <FilePick label="Add sprite set…" accept=".png" onPick={(f) => upload(f, name.trim(), { rows, members })} />
      </div>
      <Status items={items} error={error} count={shown.length} />
      <div className="assets__grid assets__grid--wide">
        {shown.map((m) => (
          <div key={m.key} className="asset">
            <ImageThumb kind="spriteSet" item={m} size={96} crop />
            <div className="asset__name">{m.key}</div>
            <div className="asset__meta">
              {m.meta.width}×{m.meta.height} · {m.meta.fight ? '3 rows' : m.meta.attack ? '2 rows' : '1 row'}
              {m.meta.members ? ' · members' : ''}
            </div>
            <UsedBy uses={m.usedBy} />
            <div className="asset__actions">
              <FilePick
                label="Replace"
                accept=".png"
                onPick={(f) =>
                  upload(f, m.key, { rows: m.meta.fight ? 3 : m.meta.attack ? 2 : 1, members: m.meta.members === true })
                }
              />
              <button type="button" className="btn btn--sm" onClick={() => act(() => downloadAsset('spriteSet', m.key, 'png'))}>
                sheet .png
              </button>
              <DeleteButton
                uses={m.usedBy}
                onDelete={() => act(async () => (await deleteAsset('spriteSet', m.key), `Deleted ${m.key}.`)).then(reload)}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ----------------------------------------------------------- item sprites -- */

function ItemSpritesTab({ act }: { act: Act }) {
  const { items, error, reload } = useLibrary('itemSprite');
  const text = useCallback((m: LibraryItem) => `${m.key} ${m.usedBy.map((u) => u.label).join(' ')}`, []);
  const { query, setQuery, shown } = useFilter(items, text);

  async function upload(files: FileList | null, key: string) {
    const main = files?.[0];
    if (!main) return;
    if (await act(async () => summary(`sprite ${key}`, await uploadAsset('itemSprite', key, { main })))) reload();
  }

  const count = items?.length ?? 0;
  return (
    <>
      <p className="hint assets__intro">
        Items use a sprite by its <b>number</b>. Sprites are 48×32 PNGs, stored 30 to a file with
        one palette per file, so a file&apos;s 30 sprites share at most 254 colours. Moving or
        deleting a sprite renumbers the ones after it, and the items follow.
      </p>
      <div className="assets__bar">
        <input type="search" aria-label="Filter item sprites" placeholder="filter by number or item" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="spacer" />
        <FilePick label={`Add sprite ${count}…`} accept=".png" onPick={(f) => upload(f, String(count))} />
      </div>
      <Status items={items} error={error} count={shown.length} />
      <div className="assets__grid assets__grid--small">
        {shown.map((m) => {
          const index = Number(m.key);
          return (
            <div key={m.key} className="asset">
              <ImageThumb kind="itemSprite" item={m} size={48} />
              <div className="asset__name">#{m.key}</div>
              <UsedBy uses={m.usedBy} />
              <div className="asset__actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={index === 0}
                  title="Move up"
                  onClick={() => act(() => moveItemSprite(index, index - 1)).then(reload)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={index === count - 1}
                  title="Move down"
                  onClick={() => act(() => moveItemSprite(index, index + 1)).then(reload)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  title="Move to a number"
                  onClick={() => {
                    const to = Number(window.prompt(`Move sprite ${index} to`, String(index)));
                    if (Number.isInteger(to) && to !== index) void act(() => moveItemSprite(index, to)).then(reload);
                  }}
                >
                  #
                </button>
                <FilePick label="Replace" accept=".png" onPick={(f) => upload(f, m.key)} />
                <button type="button" className="btn btn--sm" onClick={() => act(() => downloadAsset('itemSprite', m.key, 'png'))}>
                  .png
                </button>
                <DeleteButton
                  uses={m.usedBy}
                  onDelete={() => act(async () => (await deleteAsset('itemSprite', m.key), `Deleted sprite ${m.key}.`)).then(reload)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ------------------------------------------------------------- building blocks -- */

function DefinitionTable<T extends object>({
  kind,
  rows,
  act,
  columns,
  blank,
  newLabel,
  describeNew,
  pickNew
}: {
  kind: LibraryTable;
  rows: readonly T[];
  act: Act;
  columns: Array<[string, (row: T, index: number) => React.ReactNode]>;
  blank: () => T;
  newLabel: string;
  describeNew: (row: T) => string;
  pickNew: (current: T) => T | null;
}) {
  return (
    <div className="assets__table-wrap">
      <table className="access__table assets__table">
        <thead>
          <tr>
            <th>#</th>
            {columns.map(([label]) => (
              <th key={label}>{label}</th>
            ))}
            <th className="access__actions">
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => {
                  const row = pickNew(blank());
                  if (row) void act(async () => `Added ${kind.slice(0, -1)} ${await addDefinition(kind, row as Record<string, unknown>)} (${describeNew(row)}).`);
                }}
              >
                {newLabel}
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>{i}</td>
              {columns.map(([label, cell]) => (
                <td key={label}>{cell(row, i)}</td>
              ))}
              <td className="access__actions">
                <button type="button" className="btn btn--sm" disabled={i === 0} title="Move up" onClick={() => act(() => moveDefinition(kind, i, i - 1))}>
                  ↑
                </button>
                <button type="button" className="btn btn--sm" disabled={i === rows.length - 1} title="Move down" onClick={() => act(() => moveDefinition(kind, i, i + 1))}>
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  title="Move to a number"
                  onClick={() => {
                    const to = Number(window.prompt(`Move ${kind.slice(0, -1)} ${i} to`, String(i)));
                    if (Number.isInteger(to) && to !== i) void act(() => moveDefinition(kind, i, to));
                  }}
                >
                  #
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  onClick={() => {
                    if (window.confirm(`Delete ${kind.slice(0, -1)} ${i}? Everything numbered after it moves down one.`)) {
                      void act(async () => (await deleteDefinition(kind, i), `Deleted ${kind.slice(0, -1)} ${i}.`));
                    }
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImageThumb({
  kind,
  item,
  size,
  crop = false
}: {
  kind: LibraryKind;
  item: LibraryItem | undefined;
  size: number;
  /** sprite sheets: show the first cell only */
  crop?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!item) return;
    let alive = true;
    previewUrl(kind, item.key, item.sha256).then(
      (u) => alive && setUrl(u),
      () => alive && setUrl(null)
    );
    return () => {
      alive = false;
    };
  }, [kind, item]);
  if (!item) return <span className="asset__thumb asset__thumb--missing" style={{ width: size, height: size }} title="missing" />;
  const width = Number(item.meta.width) || size;
  const height = Number(item.meta.height) || size;
  const scale = Math.min(size / width, size / height);
  return (
    <span className="asset__thumb" style={{ width: size, height: size }}>
      {url &&
        (crop ? (
          <span
            className="asset__crop"
            style={{
              width: width * scale,
              height: height * scale,
              backgroundImage: `url(${url})`,
              backgroundSize: `${width * 15 * scale}px auto`
            }}
          />
        ) : (
          <img src={url} alt={item.key} width={width * scale} height={height * scale} />
        ))}
    </span>
  );
}

function UsedBy({ uses }: { uses: LibraryItem['usedBy'] }) {
  if (uses.length === 0) return <div className="asset__uses asset__uses--none">unused</div>;
  const title = uses.map((u) => u.label).join('\n');
  return (
    <div className="asset__uses" title={title}>
      used by {uses.length === 1 ? uses[0]!.label : `${uses.length}: ${uses[0]!.label}, …`}
    </div>
  );
}

function DeleteButton({ uses, onDelete }: { uses: LibraryItem['usedBy']; onDelete: () => void }) {
  return (
    <button
      type="button"
      className="btn btn--sm btn--danger"
      disabled={uses.length > 0}
      title={uses.length > 0 ? 'Still in use; change what uses it first' : 'Delete'}
      onClick={() => {
        if (window.confirm('Delete this asset?')) onDelete();
      }}
    >
      Delete
    </button>
  );
}

function FilePick({
  label,
  accept,
  multiple = false,
  onPick
}: {
  label: string;
  accept: string;
  multiple?: boolean;
  onPick: (files: FileList | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn btn--sm" onClick={() => input.current?.click()}>
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        aria-label={label}
        onChange={(e) => {
          onPick(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

function Status({ items, error, count }: { items: unknown[] | null; error: string | null; count: number }) {
  if (error) return <p className="gate__error">{error}</p>;
  if (!items) return <p className="hint assets__intro">Loading…</p>;
  if (count === 0) return <p className="empty">Nothing matches.</p>;
  return null;
}

function summary(name: string, result: { created?: boolean; unchanged?: boolean; warnings: string[] }): string {
  const what = result.unchanged ? `${name} is unchanged.` : result.created ? `Added ${name}.` : `Replaced ${name}.`;
  return result.warnings.length ? `${what} Note: ${result.warnings.join('; ')}.` : what;
}

function describe(err: unknown): string {
  if (isApiHttpError(err)) return err.message;
  return err instanceof Error ? err.message : String(err);
}
