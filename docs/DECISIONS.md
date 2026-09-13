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
codec, proven byte-exact against all 596 landscape files in `fixtures/data204`.

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
  596/596. Zero tolerance — this is CI's hard gate. The count is asserted in
  `roundtrip.test.ts` (120/171/2 free, 122/181/0 members), not quoted from
  memory: it was carried as "594" here for a while and was simply wrong.

  Whole-**archive** byte equality is a different and impossible claim: repacking
  `land63.jag` gives 184,498 bytes against the original 142,383, because bzip2
  frames the blocks differently. Measured, not assumed. The guarantee is
  per-entry, which is what the client actually reads.
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

## 8. Resolve models by name; `objectDef.model.id` is off by one

**Verified: 409 of 1189 objects carry a wrong `model.id`.**

`config.models` is not a section of `config85.jag`. rsc-config synthesises it
while decoding objects, using:

```js
index = this.models.push(name);   // returns the new LENGTH, not the new index
```

So the first object to mention a given name records `index + 1`; every later
object referencing the same name gets the correct value. Object 0 ("Tree") has
`model.name: "tree2"` and `model.id: 1`, but `models[1]` is `"tree"` and
`models[0]` is `"tree2"`.

This fails quietly and looks like a rendering bug: a third of all scenery would
draw as *some other object's model*. **`model.name` is the only reliable key.**
Use `modelIndexOf()` in `packages/cache`.

### Related: the cache ships a dangling model reference

`config.models` contains `runiteruck1`; the archive contains `runiterock1.ob3`.
Its only user is object 211 ("Rock"). The real client hits the same dead end.
`loadModels` reports it in `.missing` rather than silently repairing it —
repairing would make an export differ from its import.

### Related: two more load-bearing "transparent" values

Alongside the `transparent` colour keyword in §6:

- **`texture: 0` is a real texture**, not a falsy absence. rsc-models' own
  encoder tests `if (face.texture)` and emits `NaN` for it; 12 face sides in the
  cache use texture 0. Check the shape of the fill, never its truthiness.
- **Pure green `0x00ff00` in a texture palette is a cutout**, punching a hole
  through whatever is behind it. Exactly six sprites rely on it: `doorway`,
  `crumbled`, `tentbottom`, `tentdoor`, `lowcrumbled`, `flames`.

## 9. One sector lives in BOTH archive sets

Sector `3/55/55` keeps its `.hei` (terrain) in `land63.jag` — the **free**
archive — and its `.dat` (walls) in `maps63.mem` — the **members** one. A single
sector's data is split across the two sets.

`loadLandscape` originally built a fresh set of lanes for each archive set and
replaced the map entry, so the members pass silently discarded that sector's
entire terrain. It loaded with zero elevation and nothing else in the suite
noticed: one sector out of 350, and every per-entry round-trip still passed,
because the *entries* were fine — it was the merge that lost data.

The lanes are now built once per coordinate and both sets are applied to them,
free then members, which is what rsc-landscape's own `parseArchives` always did.
A sector is marked `members` if any members entry contributed to it.

Pinned by `roundtrip.test.ts` → "a sector split across the free and members
archives".

Consequence for export: `exportLandscape` writes each sector to exactly one
archive pair, so re-exporting `3/55/55` puts its terrain and walls together in
the members set rather than restoring the original split. Per-entry bytes are
preserved; the original *distribution across archives* is not. That matters only
if you diff archives rather than sectors.

## 10. Toolchain is user-local and portable

This machine had no Node, Git or Docker. Rather than machine-wide installers
needing admin, everything lives under `~\.local` and is on the user PATH:

- `~\.local\node` — Node 24.21.0 LTS (portable zip)
- `~\.local\git` — PortableGit 2.55.0
- pnpm 12.4.1 via corepack

Docker Desktop is installed **per-user**, not machine-wide:
`%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin`. It is on the user PATH,
but a shell started before the install will not see it.

## 11. Integration tests skip themselves without a database

`packages/db` and `apps/server` each carry an `integration.test.ts` that talks to
a real Postgres. They decide at collection time, with a top-level `await` probe,
whether a server is reachable and `describe.skipIf` themselves out if not — so
`pnpm test` still works on a machine with no Docker, and CI gets the full run
when a service container is present.

```sh
pnpm db:up          # docker compose up -d
pnpm db:migrate     # both the dev and test databases
pnpm test
```

The test suite uses a **separate database** (`rsc_editor_test`, created by
`docker/initdb/`). Tests assert exact row counts and create schema freely;
sharing a database with your working data would eventually destroy it.

`pnpm db:migrate` runs `scripts/migrate.mjs` rather than an npm script, because
`DATABASE_URL=... drizzle-kit migrate` is a POSIX shell idiom that silently does
nothing on Windows — half the team would migrate the wrong database.

### What running against a real server settled

- `gen_random_uuid()` is available (Postgres 17, built in — no `pgcrypto`).
- The `bytea` custom type round-trips a full sector frame byte-for-byte,
  including negative Int32 values in the diagonal lane.
- The `ops` append-only trigger fires: `UPDATE ops` raises.
- **The seq allocator does what it claims.** With writer A's transaction held
  open, writer B provably cannot obtain a seq; it blocks until A commits, and
  then gets the next number. 40 concurrent appenders produce a dense 1..40 with
  no gaps and no duplicates, and a rolled-back append hands its number back —
  which a `SEQUENCE` would not.
- Sessions resolve only while live, and only when the cookie is correctly
  signed; an unsigned cookie carrying a *valid* token is refused.
- A non-member gets an identical 404 for "not yours" and "does not exist", so
  project existence does not leak.

- **Migrations are reversible, measured rather than asserted.** Every migration
  applies to a scratch database, reverses to a genuinely empty schema (0 tables,
  0 enums — a down file that leaves something behind is not a rollback, it is a
  mess the next `up` collides with), and re-applies to the identical schema with
  the append-only trigger restored. A structural test also fails if a forward
  migration has no matching `down/` file, which is the realistic failure: down
  files are hand-written and rot silently until someone needs one under
  pressure.

Still unverified: the Discord OAuth **callback**. The redirect half is confirmed
to build a correct authorize URL with `state` and the right `redirect_uri`, but
completing a login needs a real Discord application.
