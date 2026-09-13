# @rsc-editor/import-cache

Cache directory -> Postgres project. A batch job, deliberately not an HTTP
endpoint: it decodes every landscape sector and every definition in a mudclient
cache and writes a few thousand rows, none of which belongs behind a request
timeout.

```sh
pnpm --filter @rsc-editor/import-cache run import -- \
    --cache ./fixtures/data204 --project "Gielinor"
```

> Use `run import`, not `import`. `pnpm import` is a built-in pnpm command
> (lockfile conversion) and shadows the script name.

Relative paths are resolved against the directory you ran the command from, not
the package directory, so `./fixtures/data204` means what it looks like when
typed at the repo root.

## Flags

| flag | meaning |
|---|---|
| `--cache <dir>` | cache directory to read. Required. |
| `--project <name>` | project name; the slug is derived from it. Required. |
| `--slug <slug>` | override the derived slug. |
| `--owner <uuid>` | user id to own the project. Defaults to a `cache-importer` service account, created on demand. |
| `--scenery <file>` | also place scenery from a placement list. **Off by default** — see below. |
| `--database-url <url>` | Postgres URL. Defaults to `$DATABASE_URL`. |
| `--replace` | re-import into the existing project with this slug. |
| `--dry-run` | decode and report; write nothing. |
| `--no-verify-config` | skip the config pack/reload check. |
| `--quiet` | summary only, no progress lines. |

An unrecognised flag is an error rather than being ignored: `--dry-run`
misspelled as `--dry` must not quietly run a real import.

## Re-import semantics

Without `--replace`, an existing slug is an error — silently writing into a
project someone else made is worse than stopping.

With `--replace`, the import is an **update**: sectors and definitions go
through the `putSector` / `putDefinition` upserts (one row per coordinate and
per `(kind, index)`, `version` bumped), and a cache asset whose sha256 is
unchanged is not rewritten at all. Re-running over the same cache therefore
leaves exactly the same rows; the summary reports `0 written, 28 already
current`.

Every derived asset is byte-deterministic for this reason — the sprite packer
sorts stably, the models document is emitted in `config.models` order, and
node's gzip writes a zero MTIME rather than the current time. A builder that was
"the same picture, different bytes" would invalidate every client's cached copy
on every import.

Nothing is ever deleted. Re-importing a *smaller* cache leaves the surplus rows
behind, because an importer that deletes by default turns a mistyped `--cache`
into data loss. Use a fresh `--slug` when you want a clean project.

## What it writes

- **sectors** — one row per populated coordinate, holding `encodeSectorFrame`'s
  bytes verbatim, with the free/members origin preserved in both the row column
  and the frame header.
- **definitions** — all ten kinds, validated against `@rsc-editor/schema` on the
  way in, indexed `0..n-1` with no gaps (model ids and tile overlays are indices
  into these lists).
- **cache_assets** — every file in the cache directory as `kind = 'archive'`, so
  an export can be diffed against its import, plus fourteen derived assets that
  `apps/server/src/routes/cache-assets.ts` serves to the browser.

### The derived assets (`docs/CACHE-ASSET-API.md` is the frozen contract)

| asset | on `fixtures/data204` |
|---|---|
| `models.index.json` | the `config.models` name table, 6 kB |
| `models.json.gz` | 408 decoded `.ob3`, gzipped: 5.0 MB -> 550 kB |
| `texture-atlas.png` + `.layout.json` | 1024x896, 56 cells |
| `world-map.<plane>.png` + `.meta.json` | 816x912 each, planes 0-3 |
| `entity-sprites.png` + `.layout.json` | 4096x2830, 4599 cells |

Three things about these are easy to get wrong and are pinned by tests:

- **Models are keyed by name, never by `objectDef.model.id`**, which is wrong
  for 409 of the 1189 objects (DECISIONS §8).
- **The world map uses the renderer's terrain ramp**, not a second copy of it.
  `@rsc-editor/cache` owns the canonical `TERRAIN_COLOURS` and
  `src/world-map.test.ts` compares it to `packages/render`'s entry by entry — a
  map drawn from a drifted ramp looks completely convincing.
- **Item sprites are not in `entity<n>.jag`.** They are `objects1.dat` ..
  `objects15.dat` in `media<n>.jag`, thirty frames each; the entity archive
  holds the *animation* sprites. Both were established by accounting for every
  entry in the archives, not from documentation.

## `--scenery`

Scenery is **not in the cache**. RuneScape Classic's server tells the client
what trees, fences, tables and signposts exist, the same way it does for NPCs;
the archives carry terrain, walls, roofs and overlays, and exactly two `.loc`
entries — `m05049` and `m05050`, the Lumbridge login-screen backdrop. Every
other sector in the shipped cache has no scenery at all. See
`fixtures/scenery/SOURCE.md`.

```sh
pnpm --filter @rsc-editor/import-cache run import -- \
    --cache ./fixtures/data204 --scenery ./fixtures/scenery/object-locs.json \
    --project "Gielinor" --replace
```

The flag is off by default because a plain import has to stay byte-exact against
the source archives, and that is only *provable* when nothing else is mixed into
the lanes. Adding scenery is a decision, with a visible flag.

### What it writes

`objectId + OBJECT_ID_BIAS` into `wallsDiagonal`, and the facing into
`direction`, repeated across the object's footprint — the cache's own encoding.
There is no second code path: the renderer, the scenery tool, the op log,
locking and undo all already read this.

### The coordinate mapping, and how it is checked

`position` is game coordinates with the plane folded into y at `PLANE_HEIGHT`
(944). The sector is `floor(x / 48) + 48`, `floor((y % 944) / 48) + 37`, and the
tile inside it is `(x % 48, (y % 944) % 48)` — **not** mirrored in x, despite
rsc-landscape's `tiles[47 - (x % 48)]`, whose `tiles` array is itself reversed.

Two things here are wrong in rsc-landscape and both fail silently, scattering
scenery across the world plausibly enough to look almost right:

- its `getTileAtGameCoords` folds planes with a stride of **943**. Measured
  against this cache, that strands 25 placements on sector coordinates with no
  terrain and 38 outside the sector grid; 944 puts all but two on a real sector.
- the x mirror, which cancels against the `reverse()` and must not be applied.

Both are pinned by the oracle in `packages/cache/src/scenery.test.ts`: the two
`.loc` sectors are data the real client reads, so the placement list must
reproduce them tile for tile. It does — all 291 scenery tiles accounted for,
277 identical in id *and* direction, 14 differing only in open-vs-closed variant
(`gate` 59/60, `doors` 63/64), and 34 tiles the list adds that no `.loc` can
hold.

### On `fixtures/data204`, with the vendored list

| | |
|---|---|
| placements read | 26,902 |
| placed | 26,435, over 30,741 tiles in 333 of 350 sectors |
| skipped: `empty-footprint` | 55 — `objects[581]` is 0x0 (DECISIONS §6) |
| skipped: `missing-sector` | 2 — the list uses `3/50/39`, which this cache has not |
| skipped: `diagonal-wall` | 9 — the tile already holds a `/` or `\` wall |
| skipped: `occupied-by-cache` | 248 — Lumbridge's own `.loc` already has them |
| skipped: `occupied-by-placement` | 153 — the list puts two objects on one tile |

A placement is all-or-nothing: one blocked tile skips the whole object, because
a half-written table draws in full and mis-maps the picker. Nothing already in
the lane is ever overwritten, in either direction — no diagonal wall is lost and
Lumbridge keeps the data the client actually ships.

### The cost

An export of a scenery-imported project writes `.loc` entries for sectors the
original cache did not have them for, so it is no longer byte-identical to the
cache it came from. Import without `--scenery` when that matters.

Worse, and not yet handled anywhere: a `.loc` byte is `objectId + 1` and any
byte `>= 128` is a run of zeroes, so the format cannot express an id above
**126**. The placement list uses ids up to 1188. `encodeLoc` stays a verbatim
inverse of `decodeLoc` (it is half the 596-file gate), so it will happily emit a
byte that decodes to something else — an export path must call
`unrepresentableSceneryIds()` from `@rsc-editor/cache` first and refuse, rather
than write a `.loc` that turns a potato into 64 blank tiles.

## The fidelity gate

`src/import.integration.test.ts` imports `fixtures/data204` into a scratch
project, reads the sectors back **out of Postgres**, re-encodes them and
compares the bytes to the entries in the source archives: 593 of the 596
landscape entries, byte for byte. The three that are not compared are properties
of the cache and are each asserted individually — two all-zero members `.dat`
sectors that `loadLandscape` drops as the client does, and the free copy of
sector 3/55/55, which the members set shadows.

Whole-archive byte equality is *not* asserted and is not achievable: repacking a
`.jag` produces different bzip2 block framing, exactly as it does for
`config85.jag` (DECISIONS §3). The guarantee is per landscape entry, which is
what the 596-file gate in `packages/cache` means too.
