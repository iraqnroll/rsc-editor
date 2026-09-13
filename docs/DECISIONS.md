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

## 12. Scenery is not in the cache either

The cache holds exactly **two** `.loc` entries — `m05049` and `m05050`.
rsc-landscape's own source calls them "the sectors shown in login", and that is
what they are: the Lumbridge backdrop. Every other sector has no scenery at all.

RuneScape Classic sends scenery from the server, like NPCs and ground items. The
`wallsDiagonal` lane genuinely encodes scenery ids above 48000 (§2), which makes
the cache *look* like it stores scenery. It stores scenery for two sectors.

The real placements — 26,902 of them across 342 sectors — come from
`object-locs.json` in the same 2003scape project, vendored at
`fixtures/scenery/` with provenance. Importing them is a separate, explicit
`--scenery` flag so that a plain cache import stays byte-exact, which is only
provable if nothing else is mixed in. See `fixtures/scenery/SOURCE.md`.

### Two mapping rules rsc-landscape gets wrong

Both fail silently, scattering objects *plausibly*:

- **There is no x mirror.** `getTileAtGameCoords` reads
  `tiles[47 - (x % 48)][y % 48]`, but `populateTiles()` ends with
  `this.tiles.reverse()` — the two mirrors cancel, and the lane column is plainly
  `x % 48`.
- **The plane stride is 944, not 943.** Measured against the real data: 943
  strands 25 placements on coordinates with no terrain and puts 38 outside the
  sector grid; 944 (our `PLANE_HEIGHT`) lands 26,900 of 26,902 on a real sector
  and none outside.

The check that settled it is free and exact: the two `.loc` sectors we *do* have
are an oracle. Of their 291 scenery tiles, zero are unaccounted for by the
computed placements and 277 match in id and direction; the 14 that differ are
open-vs-closed variants of the same object (`gate` 59/60, `doors` 63/64),
asserted as that pairing rather than tolerated by a threshold.

### Export hazard: `.loc` cannot represent most scenery ids

**Nothing writes a `.loc` yet, and nothing may until this is handled.**

A `.loc` byte is `objectId + 1`, and any byte `>= 128` decodes as a *run of that
many blank tiles*. The format therefore tops out at **object id 126**. The real
placement list uses ids up to 1188.

`encodeLoc` is a verbatim inverse of `decodeLoc` and stays that way — it is half
the 596-entry gate. So it will happily emit a byte that reads back as 64 empty
tiles. `unrepresentableSceneryIds()` in `@rsc-editor/cache` is the pre-export
check; **it is not called anywhere yet**, because there is no exporter.

Whoever builds the export flow has to decide: refuse, drop the unrepresentable
objects, or write scenery to the server's own format instead of `.loc`. The last
is probably right — it is where the game keeps it.

## 13. Game `x` increases WESTWARD, so every map mirrors it

Walking east in RuneScape Classic *decreases* your x coordinate. Canonical maps
are therefore drawn with the x axis reversed, and rsc-landscape's own painter
does it in two places:

```js
for (let i = maxX; i >= minX; i -= 1) { … x += sectorWidth * TILE_SIZE; }  // sectors
x = this.imageWidth - x - 2;                                               // objects
```

Our world map painted `pixelX = gameX` directly and came out **horizontally
flipped** — the Wilderness on the left instead of the right. Corrected to a
single uniform mirror across the whole axis:

```
pixelX = image.width - 1 - gameX * tileSize
```

`docs/CACHE-ASSET-API.md` holds the full formula; `meta.xAxis` is `"mirrored"`.

### Two different mirrors, and they are not the same mirror

This lives dangerously close to §12, where the conclusion was "there is **no** x
mirror". Both are true, because they are different spaces:

- **Lane space** (`packages/cache/src/scenery.ts`): the lane column is plainly
  `x % 48`. rsc-landscape's `tiles[47 - x % 48]` cancels against its own
  `tiles.reverse()`. No mirror.
- **Map-image space** (`tools/import-cache/src/world-map.ts`): mirrored, as
  above.

Anyone reading one and "fixing" the other to match will break the one they did
not read. Both files carry a comment saying so.

### Why every test passed

This is the important part. **The sector data is internally consistent either
way.** Every existing map test compared the image to the landscape lanes through
a shared `pixelOf` helper — mirror the painter and the helper together and all
of them stay green while the picture is backwards. The lanes carry no absolute
sense of east and west, so no amount of internal checking can decide the
question.

It needed a judge from outside our own arithmetic. The test now uses one:
rsc-landscape's `inWilderness(x, y)` box, which states *in image pixels* where
the Wilderness lands on a correctly oriented map. In that box our plane 0 is
99.6% opaque and 95.2% brown; reflected across x it is 4.5% opaque and 1.2%
brown — open sea. A flip swaps those exactly. A second test lands 108 of 110 of
upstream's place labels on drawn ground, versus 83 when reflected.

The teeth were verified rather than assumed: with the painter reverted, both
tests fail.

**The bug was found by a human looking at the picture and recognising the
world.** No test we owned could have caught it, and that is worth remembering
next time something is "proven correct" against only its own inputs.

### The 3D view had the same bug, and it was ours, not mudclient's

The viewport was mirrored too — east on the left. The first analysis concluded
this was inherent: game x increases westward, +z is south, so `(East, North,
Up)` is left-handed in render space and no camera angle can fix it. That much is
true. The conclusion drawn from it — that mudclient is mirrored as well, and
that matching the map meant giving up fidelity to the client — **was wrong.**

mudclient's `GameModel#project` divides by z with no sign games. At identity
rotation its screen right is `+x` (west) while it looks along `+z` (south) —
and facing south, west *is* on your right. Turn to face north and east comes
round to the right. The client agrees with its own maps.

What was mirrored was **our** render space. Negating client y to get three.js
Y-up is `diag(1, -1, 1)`, determinant −1. `RscModel.build` compensated the
*winding*, which keeps one-sided surfaces showing the correct face but does
nothing about the mirrored picture. Adding the x flip makes the whole map
`diag(-1, -1, 1)`, determinant +1 — a plain 180° rotation.

So the fix makes the editor match the client **and** the map. There was no
trade-off; there was a sign error wearing one.

`packages/render/src/render-space.ts` owns `RENDER_X_SIGN` and says, loudly,
that the constant and the winding reversal in `build` are one change: remove
one and keep the other and the whole world silently inverts.

The acceptance test projects two tiles through the real north-up camera pose
with three's own `project()` and asserts the smaller game x lands further
right, restating the map's `pixelX = width - 1 - gameX` as the independent
judge. Setting `RENDER_X_SIGN` back to `+1` fails **that test and only that
test** — 36 other scene tests stay green, which is §13's failure mode caught in
the act.

Two latent bugs surfaced on the way: `multi-plane-preview` was passing by luck
with its camera ~10,000 units off target, and `model-preview`'s bounds read raw
client x while claiming render space, so off-centre models framed the mirror
image of their own geometry.

### Two kinds of wrong, and why one test set cannot see both

The 2D fallback viewport (used when there is no WebGL2) had to be mirrored with
everything else. Fixing it produced the clearest demonstration in this project
of *why* a test suite passes a broken thing.

Two faults were injected, each restoring the file byte-identically afterwards:

| injected fault | what failed |
|---|---|
| the whole pre-mirror transform | the map-judged tests — **pan and zoom passed** |
| a half-applied flip: draw and pick mirrored, pan and zoom left behind | pan and zoom — **the map-judged tests passed** |

Disjoint. The pan/zoom tests are internally consistent under a full mirror and
cannot see one; the map-judged tests compare against `data/world-map.ts` and
cannot see a half-applied flip, because nothing *drawn* is wrong. Neither set
alone is sufficient, and either alone would have shipped a broken viewport with
a green suite.

The map-judged assertions are equality rather than ordering, which is possible
because a canvas showing exactly one 48x48 sector at 4 px/tile *is*, pixel for
pixel, a world map image of that sector at `tileSize: 4`. So `screenToTile`
must equal `mapToTile` across a sweep of pixels — literally "the tile the world
map would name for that spot".

Three things in the fallback changed side rather than sign, each of which would
have read as a different bug entirely:

- a rect grows **leftward** from its origin column once mirrored, so a 48-tile
  sector border and a 1-tile cell no longer start at the same pixel; sharing a
  default would have put every sector outline 47 tiles from its sector
- `wallsVertical` spans grid column x, which mirrored is the tile's **right**
  edge — left alone, every wall in the world draws one tile out, which looks
  like a lane-decoding bug
- the two diagonal rotations swap, which is simply what a mirror does to a
  diagonal

The implementation record — the `diag(RENDER_X_SIGN, -1, 1)` derivation, every
module that had to follow, and each test expectation that moved — is in
`docs/HANDOFF-render-x-mirror.md`. This section is the authority on *why*; that
file is the authority on *where*.
