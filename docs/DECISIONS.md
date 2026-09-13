# Decisions

Findings that cost real time to establish. Each one is load-bearing; read before
changing the area it covers.

---

## 1. We own the landscape codec; we do not call rsc-landscape at runtime

`@2003scape/rsc-landscape` parses correctly but we do not use it in the server
path, for three reasons:

1. **Its `toDat()` corrupts object tiles.** See below.
2. **It hard-depends on `node-canvas`**, which has no prebuilt binary for Node
   22+ and needs Python + MSVC. We will not put a C toolchain in the deploy path.
3. **It models sectors as `Tile` object graphs.** We store struct-of-array lanes.
   Converting between the two on every read would dominate the cost of a read.

`packages/cache/src/landscape-codec.ts` is a deliberate, verbatim port of its
codec, proven byte-exact against all 594 landscape files in `fixtures/data204`.

It stays a *verbatim* port. The encodings contain at least one genuine asymmetry
(documented at `decodeHei`) that looks like a bug and is not — "fixing" it breaks
real maps.

## 2. The `toDat()` object-id leak (fixed here, still present upstream)

`wallsDiagonal` is one Int32 lane multiplexing three things:

| range | meaning |
|---|---|
| `1 .. 11999` | `/` diagonal wall |
| `12000 .. 47999` | `\` diagonal wall (overlay + 12000) |
| `48000+` | scenery object id, stored as `objectId + 48001` |

rsc-landscape writes the `\` block as `d >= 12000 ? d - 12000 : 0`. Object ids
are also `>= 12000`, so an object tile writes `(48001 + id - 12000) & 0xff` into
the raw diagonal byte block — **fabricating diagonal walls that were never
there**.

It hides when you re-read through the same library, because the later `.loc`
pass overwrites the lane. It is real corruption in an exported cache.

Measured on `fixtures/data204`: 94 and 196 corrupted bytes in `m05049.dat` and
`m05050.dat` — precisely the two free-world sectors carrying a `.loc`. Excluding
the object range makes all 350 `.dat` files byte-exact.

Guarded by a dedicated regression test, not just the round-trip test, so the
intent survives a refactor.

## 3. Byte-exact for landscape, semantic for config

- **Landscape**: every `.hei`/`.dat`/`.loc` must re-encode to identical bytes.
  594/594. Zero tolerance — this is CI's hard gate.
- **Config**: `config85.jag` does *not* repack byte-identically (58,819 →
  59,086 bytes) because bzip2 block framing differs. That is cosmetic; the client
  parses the archive, it does not checksum it. The guarantee is **semantic**:
  every definition survives a pack/reload cycle unchanged, enforced by
  `assertConfigRoundTrip` before any export is offered to a user.

## 4. Pinned to the v1 archiver line

| package | version | why |
|---|---|---|
| `@2003scape/rsc-archiver` | `^1.1.1` | CJS, synchronous, pure-JS bzip2 |
| `@2003scape/rsc-config` | `^1.0.1` | sits on the v1 archiver |

`rsc-archiver@2` / `rsc-config@2` use `bzip2-wasm`, which **is broken on
Windows**: `bzip2-wasm/index.js:29` does

```js
globalThis.__dirname = dirname(import.meta.url);   // "file:///C:/..."
```

instead of `dirname(fileURLToPath(import.meta.url))`, so Emscripten resolves the
`.wasm` to `C:\C:\Users\...` and aborts. It also makes archive loading async for
no benefit to us.

Staying on v1 additionally removes a version skew: rsc-landscape bundles
archiver v1 while config v2 wants v2, so a mixed tree would carry two copies
with different `hashFilename` implementations in play.

## 5. `canvas` override

Nothing depends on `node-canvas` today. The `overrides` entry in
`pnpm-workspace.yaml` maps it to `@napi-rs/canvas` (prebuilt, API-compatible) so
that when `packages/render` picks up `rsc-landscape` as a golden-image test
oracle, it does not drag a C toolchain in with it.

## 6. Definition schemas were derived from the cache, not from docs

`packages/schema/src/definitions.ts` was written by auditing the real
`config85.jag`: field names, nullability and enum domains all came from dumping
it. Assumptions that looked obvious and were wrong:

- `items.equip` and `items.colour` are **null** for most items (949/1290 and
  461/1290).
- Colours are not always `rgb(r, g, b)` — the keyword **`transparent`** is used
  by tile overlay 7 ("hole") and wall object 119 ("solidblank") to punch through
  geometry. It is load-bearing, not a missing value.
- `objects[581]` has **width and height 0**, so a `.positive()` constraint on
  object footprint rejects the real cache.

Counts, as a canary that the fixture has not been swapped: items 1290, npcs 794,
objects 1189, wallObjects 214, textures 55, animations 229, roofs 6, tiles 25,
spells 48, prayers 14, models 409.

## 7. `tsc --noEmit` is not optional

vitest runs through esbuild, which **strips types without checking them**. An
import of a name a module never exported yields `undefined` at runtime rather
than an error.

This bit us for real: `wire.ts` imported `TILES_PER_SECTOR` from `./sector.js`
(which imports it from `constants.js` but does not re-export it). Every offset
silently became `NaN`, `bytes.set(lane, NaN)` wrote at 0, and the frame header
was overwritten by payload. Tests failed with a baffling "bad magic" 40 minutes
after the real mistake. `tsc --noEmit` catches it instantly.

CI runs typecheck before tests, and so should you.

## 8. Toolchain is user-local and portable

This machine had no Node, Git or Docker. Rather than machine-wide installers
needing admin, everything lives under `~\.local` and is on the user PATH:

- `~\.local\node` — Node 24.21.0 LTS (portable zip)
- `~\.local\git` — PortableGit 2.55.0
- pnpm 12.4.1 via corepack

Docker is still **not installed**; it is needed from Phase 2 for Postgres.
