# RSC Editor — Collaborative Web-Based RuneScape Classic Map & Cache Editor

## Context

`C:\Users\Lukas\Documents\Programming\RSCEditor` is empty — this is a greenfield build.

The goal is a **web-based, multi-user editor for RuneScape Classic world data**: terrain, walls, roofs, scenery, and the entity/config definitions behind them — with a **detailed, client-accurate 3D preview**, so several people can log in and edit different regions of the world at the same time.

Existing RSC editors are all single-user desktop tools (Open-RSC's 2D/3D Landscape Editors, `An-actual-duck/rsc-world-editor`) or abandoned WebGL experiments (`Unravl/RSC-Landscape-Editor-HTML5`). None support concurrent editing. That's the gap.

**Key research finding that shapes everything below:** the [2003scape](https://github.com/2003scape) organisation publishes a complete, maintained **JavaScript** toolchain for RSC cache data. We do not need to write binary format parsers:

| Package | What it gives us |
|---|---|
| `@2003scape/rsc-landscape` | `Landscape` → `Sector` → `Tile` model; `loadJag()`, `parseArchives()`, `parseHei/Dat/Loc()`, `toHei/toDat/toLoc()`, `populateTiles()`, `populateBuffers()`, `toCanvas()` |
| `@2003scape/rsc-config` | All nine definition types — items, NPCs, textures, animations, game objects, wall objects, roofs, tiles, spells/prayers. `loadArchive()` / `toArchive()` / dump-json / pack-json |
| `@2003scape/rsc-archiver` | `.jag` archive compress/decompress (bzip2-derived) |
| `@2003scape/rsc-models` | `.ob3` 3D models → vertices `{x,y,z}` + faces with `fillFront`/`fillBack` (illumination flag, RGB 0–248, **or** texture index). Wavefront OBJ/MTL both directions |
| `@2003scape/rsc-sprites` | Entity/UI/texture image extraction — source for our texture atlas |
| `2003scape/rsc-client` | JS port of **mudclient204**. The reference implementation for correct terrain geometry and shading — we port from it, we don't guess |

This means the risky, unglamorous part (binary fidelity) is mostly a *wrapping and validation* job, and our real engineering effort goes where the value is: the 3D renderer, the collaboration layer, and the editing UX.

### Decisions locked in

- **Data source of truth:** 2003scape JS stack
- **Scope:** map/landscape + entity config definitions (not `.ob3` model authoring — models are read-only reference assets used for rendering and placement)
- **Concurrency:** sector checkout/locking (48×48), with live read-only broadcast to everyone else
- **Auth:** Discord OAuth2, self-hosted via Docker Compose
- **3D:** faithful client-accurate render + toggleable editor overlays
- **Stack:** TypeScript monorepo — pnpm workspaces + Turborepo, React + Vite + react-three-fiber, Fastify + WebSocket, Postgres + Drizzle, Zod shared schemas
- **Process:** plan the product *and* stand up multi-agent orchestration scaffolding

---

## Architecture

```
RSCEditor/
├── CLAUDE.md                      # conventions, commands, file-ownership map
├── .claude/
│   ├── agents/                    # specialist agent definitions
│   └── workflows/                 # Workflow tool scripts
├── apps/
│   ├── web/                       # React + Vite + r3f editor
│   └── server/                    # Fastify REST + WS realtime
├── packages/
│   ├── schema/                    # ★ Zod contracts: sector payload, ops, WS protocol, defs
│   ├── cache/                     # wraps @2003scape/* — import, normalise, export, round-trip
│   ├── render/                    # framework-agnostic RSC geometry + shading builders
│   └── db/                        # Drizzle schema + migrations
├── tools/
│   └── import-cache/              # CLI: cache dir → Postgres project
├── fixtures/                      # real cache files + golden outputs (git-lfs)
└── docker/
```

`packages/render` is deliberately **framework-agnostic** — it takes a sector payload and returns `BufferGeometry` data. That keeps the hard geometry logic unit-testable and headless-renderable without mounting React.

### Source of truth: Postgres, not `.jag`

Import the cache once, edit in the database, export archives on demand. This is the decision that makes locking, history, undo, and multi-user coherence tractable — trying to coordinate concurrent writes against `.jag` blobs would not work.

**Tables** (`packages/db`):

- `users` — discord_id, username, avatar, global_role
- `projects` — a world snapshot; `project_members` (owner / editor / viewer)
- `cache_assets` — immutable reference blobs: models, sprites, textures, original archives
- `sectors` — `(project_id, plane, sx, sy)`, `version`, binary payload
- `sector_locks` — sector, user, acquired_at, expires_at, last_heartbeat
- `definitions` — `(project_id, kind, index)`, jsonb, version
- `ops` — **append-only log**: project, seq, actor, target, payload jsonb, created_at
- `snapshots` — named tags / exports

The `ops` table is the backbone: it powers undo/redo, per-user history, "who changed this tile", live broadcast replay for late joiners, and leaves the door open to CRDT co-editing later without a rewrite.

### Sector payload format

Store tiles as **struct-of-arrays typed buffers**, mirroring `rsc-landscape`'s own `Sector` layout: `elevation` `Uint8Array(2304)`, `colour`, `overlay`, `wallsHorizontal`, `wallsVertical`, `wallsDiagonal` (`Int32Array`), `wallsRoof`, `direction`, `objectId`.

Transferred over WebSocket as **binary frames**, never JSON. 2304 tiles × 9 attributes as JSON objects would be an order of magnitude larger and would choke the mesher. This layout also feeds GPU attribute buffers with minimal transformation.

### Realtime & locking protocol

- `lock.claim(sector)` → server verifies no live lock → grants with a 120s TTL; client heartbeats every 30s
- Release on explicit release, disconnect, or TTL expiry (a sweeper job reaps stale locks)
- Lock holder applies edits optimistically, sends ops; server assigns `seq`, persists, broadcasts to the project room
- Non-holders render the sector live but read-only, tinted with the holder's presence colour and a nameplate
- Presence channel: cursor position, camera, active tool, selected sector

**Cross-sector edge case — call this out early.** RSC tile data is sector-local but *rendering* is not: a tile on a sector boundary needs its neighbour's elevation to triangulate correctly, and walls sit on tile edges shared between sectors. Rule: claiming a sector grants **write access to that sector and read-consistency on the 8 neighbours**. Any edit whose write-set spills into an unclaimed neighbour is rejected with a "claim adjacent sector" prompt. Neighbour data is fetched read-only for meshing.

### 3D preview

This is the headline feature and the largest single chunk of work.

**Fidelity approach:** RSC's software renderer does per-face flat shading with its own lighting model. Reproducing it with three.js scene lights will *not* match. Instead, `packages/render` computes vertex/face colours using the same arithmetic as `rsc-client`, and renders with unlit materials (`MeshBasicMaterial` + vertex colours). What you see is then genuinely what the client draws.

Geometry, ported from `rsc-client`'s `src/world.js` / `src/scene.js` (themselves a port of mudclient204):
- **Terrain** — each tile is a quad split into two triangles; elevation scaled per the client's constant; colour from the terrain colour ramp; overlays override colour with a texture or flat fill, and diagonal overlays split the tile along its diagonal
- **Walls** — horizontal/vertical boundary objects extruded between tile corners at the wall definition's height; diagonal walls along the tile diagonal, with their two rotations
- **Roofs** — generated over enclosed regions at wall height
- **Scenery** — `.ob3` models via `rsc-models` → instanced `BufferGeometry`, per-face front/back fill, `direction` 0–7 rotation

**Textures** — one atlas built at import time from `rsc-sprites`, `NearestFilter`, no mipmaps, to keep the original crunchy look.

**Performance** — mesh sectors in a **Web Worker pool**; load a configurable radius around the camera; instance scenery per model id; dispose geometry outside the radius. Target a smooth 60fps with a 5×5 sector radius loaded.

**Editor overlays** (separate toggleable layers): tile grid, sector borders, lock ownership tint + nameplates, hover/selection highlight, scenery transform gizmo, brush cursor projected onto terrain, collision/walkability heatmap.

**Cameras:** orbit, free-fly, and an "in-game" preset matching RSC's fixed pitch and zoom — so you can sanity-check what a player actually sees.

### Editing tools

- **Elevation brush** — raise / lower / smooth / flatten, radius + falloff
- **Paint** — terrain colour, overlay / tile type
- **Walls** — place/remove horizontal, vertical, diagonal boundaries; wall definition picker with live 3D thumbnail
- **Roof** tool
- **Scenery** — place / rotate / delete objects, model preview in the picker
- **Region ops** — rectangle select, copy/paste, fill
- **Undo/redo** — driven by the op log, scoped to your own ops
- **Definition editors** — forms generated from the Zod schemas over all nine `rsc-config` types, with live model preview for object and wall-object defs
- **2D minimap** — `landscape.toCanvas()` for fast whole-world navigation and jump-to-sector

### Export

- Landscape → `sector.toHei/toDat/toLoc()` + `rsc-archiver` → `land`/`maps` archives
- Definitions → `config.toArchive()`
- JSON dump compatible with `rsc-data` / `rsc-server`
- Downloaded as a zip, **gated behind a validation pass**: export → re-import → deep-equal against the DB state. A failed validation blocks the download rather than handing you a corrupted cache.

### Auth

Discord OAuth2 via `@fastify/oauth2`; signed httpOnly session cookie with server-side sessions in Postgres; per-project roles (owner/editor/viewer); optional Discord guild-role sync; WebSocket authenticated from the cookie at upgrade.

---

## Multi-agent orchestration

Set up in Phase 0, used from Phase 2 onward.

**The enabling idea: contracts before fan-out.** `packages/schema` — Zod definitions for the sector payload, every op type, the WS protocol, and all nine definition kinds — is written and frozen *first*. It is the seam that lets agents work in parallel without colliding. Every agent imports it; only the schema owner edits it. Without this, parallel agents produce code that doesn't compose.

**`CLAUDE.md`** — stack rules, commands, test conventions, "never hand-edit anything in `fixtures/`", commit format, and an explicit **file-ownership map**.

**`.claude/agents/`** specialists, each scoped to directories it alone owns:

| Agent | Owns |
|---|---|
| `cache-formats` | `packages/cache`, `tools/import-cache` — round-trip correctness |
| `renderer` | `packages/render` + the r3f scene — geometry & shading fidelity |
| `realtime` | locking, WS protocol, op log, presence |
| `api-db` | `packages/db`, Fastify routes, auth |
| `editor-ux` | `apps/web` UI — tool panels, keybinds, definition forms |
| `qa` | tests, fixtures, round-trip and golden-image suites |

**`.claude/workflows/`** — Workflow scripts: `scaffold.js` (phase fan-out), `feature.js` (implement → review → verify pipeline), `roundtrip-audit.js` (sweep every sector in a real cache for fidelity regressions).

Parallel agents run with `isolation: "worktree"` so they don't fight over the working tree; integration happens on a per-phase branch.

---

## Phases

**Phase 0 — Foundations** *(solo, no fan-out)*
Repo scaffold, pnpm workspaces + Turborepo, TS config, lint/format, CI, `docker-compose` with Postgres, `CLAUDE.md`, agent definitions, and **`packages/schema` contracts**.

**Phase 1 — Cache spike** *(solo — this is the gate)*
Load a real cache with the 2003scape libs and prove a **byte-exact round-trip**: land/maps/config → our model → repack → compare against the originals. Everything downstream assumes this works, so it gets retired before any parallel work starts. Also: ambient `.d.ts` declarations for the 2003scape packages (they're plain JS).

**Phase 2 — Parallel fan-out**
`packages/cache` proper · DB + API + Discord auth · static 3D sector renderer · UI shell and minimap.

**Phase 3 — Editing + realtime**
Op log, sector locking, presence, terrain/wall/roof tools, undo/redo, live broadcast.

**Phase 4 — Definitions + scenery**
Definition editors for all nine types, scenery placement with gizmos, model/texture pipeline and atlas.

**Phase 5 — Export & ship**
Export with validation gate, snapshots/history browser, performance pass, deployment.

---

## Risks

1. **Round-trip fidelity.** `.hei` stores height and colour as run-length-encoded deltas relative to the previous tile. A naive rewrite silently corrupts maps. → Phase 1 byte-exact gate, plus `roundtrip-audit` over every sector in CI.
2. **Terrain geometry fidelity.** Guessing the triangulation/shading rules produces something that looks plausible but doesn't match the client. → Port from `rsc-client`, validate with golden-image tests against `rsc-landscape`'s own `toCanvas()`.
3. **Cross-sector coupling** vs per-sector locks (see above) — resolved by the write-set rule, but it needs to be in the op validator from day one, not retrofitted.
4. **Render performance** at scale → Web Worker meshing, instancing, radius-based streaming.
5. **Untyped dependencies** — the 2003scape packages ship no types. → Hand-written `.d.ts` in `packages/cache`, treated as part of the contract layer.

## Verification

- **Unit** — vitest over `packages/cache` round-trips against real cache fixtures; `packages/render` geometry assertions
- **Golden image** — headless-render a known sector, compare against a committed reference and against `rsc-landscape.toCanvas()`
- **Integration** — op log → apply → export → re-import → deep-equal
- **Multi-user E2E** — Playwright with two browser contexts: both log in, A claims a sector, assert B is read-only on it and sees A's edits live; assert A's lock releases on disconnect
- **Real-world** — `docker compose up`, import your cache, edit terrain and scenery, export, then load the exported cache in `rsc-client` and walk around it

## Cache sourcing — resolved

No cache files are needed from you. The complete **mudclient204** cache is publicly distributed inside `2003scape/rsc-client` at `dist/data204/`, verified to contain all 14 archives:

| File | Size | Use |
|---|---|---|
| `land63.jag` / `.mem` | 142 KB / 155 KB | Terrain — elevation & colour |
| `maps63.jag` / `.mem` | 38 KB / 59 KB | Walls, roofs, overlays, scenery locs |
| `config85.jag` | 59 KB | All nine definition types |
| `models36.jag` | 290 KB | `.ob3` scenery models |
| `textures17.jag` | 64 KB | Terrain & wall textures → atlas |
| `entity24.jag` / `.mem` | 244 KB / 48 KB | NPC/item sprites |
| `media58.jag`, `fonts1.jag`, `filter2.jag`, `jagex.jag`, `sounds1.mem` | — | UI, fonts, misc (not needed for editing) |

`2003scape/rsc-landscape` additionally ships `land63.jag`/`maps63.jag` at its repo root plus `object-locs.json`, `map-labels.json` and `map-points.json` — useful as a cross-check oracle for the importer and for minimap labels.

**Plan:** Phase 1 vendors `dist/data204/` into `fixtures/data204/` (git-lfs) via a sparse checkout, pinned to a specific commit and recorded with checksums in `fixtures/SOURCE.md`, so round-trip tests always run against a known-identical baseline. These are Jagex-copyrighted game assets used here as a local test fixture for a preservation/modding tool — they stay out of any published build.

## References

- [2003scape org](https://github.com/orgs/2003scape/repositories) — the JS toolchain
- [rsc-landscape](https://github.com/2003scape/rsc-landscape) · [rsc-config](https://github.com/2003scape/rsc-config) · [rsc-models](https://github.com/2003scape/rsc-models) · [rsc-client](https://github.com/2003scape/rsc-client)
- [HEI format — RSC Wiki](https://classic.runescape.wiki/w/HEI)
- Prior art: [Open-RSC](https://github.com/Open-RSC) 2D/3D Landscape Editors · [rsc-world-editor](https://github.com/An-actual-duck/rsc-world-editor) · [RSC-Landscape-Editor-HTML5](https://github.com/Unravl/RSC-Landscape-Editor-HTML5)