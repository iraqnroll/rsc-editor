# RSC Editor

Collaborative web-based RuneScape Classic map & cache editor. Multiple people
log in, claim 48x48 sectors, and edit terrain/walls/roofs/scenery with a
client-accurate 3D preview.

Read `docs/DECISIONS.md` before touching the cache codec, the dependency
pins, or the definition schemas. It records findings that cost real time.

## Commands

```sh
pnpm install
pnpm db:up           # Postgres in Docker
pnpm db:migrate      # dev + test databases
pnpm test            # all packages
pnpm typecheck       # REQUIRED before claiming done -- see below
pnpm build
pnpm dev
```

Per-package: `pnpm --filter @rsc-editor/cache test`

Browser, two users: `pnpm --filter @rsc-editor/web e2e` (needs `db:up`, the
server's `RSC_DEV_LOGIN=1`, and Chrome; it starts the servers if they are not
running). Not part of `pnpm test`. The Vite proxy defaults to API port 8080;
if the server runs elsewhere, set `RSC_API_PORT` for `vite dev` or
`VITE_API_BASE` in `apps/web/.env.development`. The e2e config reads the port
from `apps/server/.env`.

The integration suites skip themselves when no Postgres is reachable, so the
tests pass without Docker — but they then prove much less. Run `db:up` first.

## Windows / PowerShell 5.1 hazards

This has cost real time more than once, so it is a rule rather than a tip.

**Never round-trip a source file through `Get-Content -Raw` / `Set-Content` or
`Out-File`.** PowerShell 5.1 writes a UTF-8 BOM and mangles non-ASCII on the way
back, so an em-dash becomes mojibake and the file grows a BOM it never had. It
has silently corrupted both source files and git commit subjects here. For file
surgery use the editing tools, or `node -e` — never a shell round trip.

Also: no `&&` or `||` chaining, no ternary, no null-coalescing. Avoid `2>&1` on
native executables — PowerShell wraps stderr lines in ErrorRecords and reports
success as failure. Stderr is captured for you anyway.

## Hard rules

**1. `tsc --noEmit` is not optional.** vitest runs through esbuild, which strips
types without checking them. Importing a name a module does not export yields
`undefined` at runtime, not an error — this has already cost us an hour of
debugging (`docs/DECISIONS.md` §7). Green tests do not mean type-correct.

**2. Never hand-edit anything in `fixtures/`.** The round-trip tests assert
byte-exactness against the real cache. Editing a fixture to make a test pass
makes the test meaningless. Generate altered data inside the test instead.

**3. The landscape codec is a verbatim port. Keep it that way.** The `.hei` and
`.dat` encodings contain an asymmetry that looks like a bug and is not. Tidying
it corrupts real maps. Any change to `packages/cache/src/landscape-codec.ts`
must keep all 596 files byte-exact.

**4. `packages/schema` is frozen and single-owner.** Every package depends on it;
it is the seam that lets work happen in parallel. If you need a change there,
raise it rather than editing it — a unilateral edit breaks everyone else's
in-flight work.

**5. No `node-canvas` in the server path.** It needs Python + MSVC. See
DECISIONS §1 and §5.

**6. An op targets exactly one sector.** That is what enforces the locking rule.
A brush spilling across a sector boundary emits one op per sector, and the
server rejects ops for sectors the author does not hold. Do not add a
cross-sector op type.

## Layout and ownership

Each area has one owning agent. Do not edit outside your area; if you need a
change there, say so in your report rather than making it.

| path | owner | scope |
|---|---|---|
| `packages/schema` | `schema` | Zod contracts, wire format, constants. Frozen. |
| `packages/cache` | `cache-formats` | codec, import/export, round-trip fidelity |
| `packages/render` | `renderer` | RSC geometry + shading, mesh builders |
| `packages/db` | `api-db` | Drizzle schema, migrations |
| `apps/server` | `api-db` / `realtime` | Fastify routes + auth / WS, locks, op log |
| `apps/web` | `editor-ux` | React UI, tools, panels, definition forms |
| `tools/*` | `cache-formats` | CLIs (cache import, audits) |
| `deploy/` | `api-db` | Proxmox LXC install/update/backup, see `deploy/README.md` |
| `fixtures/` | nobody | read-only, see `fixtures/SOURCE.md` |

## Conventions

- TypeScript everywhere, ESM, `.js` extensions in relative imports.
- Packages export from `src/index.ts`; no deep imports across packages.
- Typed-array lanes (struct-of-arrays), never per-tile object graphs, for
  anything that crosses the wire or feeds the GPU.
- Tests live beside the code as `*.test.ts`.
- Comment *why*, not *what* — especially in the codec, where the "what" is
  already strange and the "why" is the only thing that stops someone helpfully
  breaking it.

## Status

- Phase 0 (foundations, contracts) — done
- Phase 1 (cache fidelity gate) — **passed**, 596/596 byte-exact
- Phase 2 — done: models/textures, client-accurate geometry (visually verified),
  db + API + Discord auth (verified against real Postgres), editor shell
- Phase 3 (editing + realtime) — **done, verified in a browser**: two users,
  locks, presence, live ops, undo/redo, reload, lock release on disconnect,
  and every tool writing an op a peer receives (`apps/web/e2e`). Stacked
  floors are drawn per corner off the client's storey grid (DECISIONS §14).
- Phase 5 — **export done**: validated zip from the API and an Export
  button (DECISIONS §15); **snapshots and the project log** in the History
  tab, with export as of a snapshot (§16); sector meshing on a Web Worker
  pool (`apps/web/src/scene/mesher.ts`); **deployment** to a Proxmox LXC
  (`deploy/`, tested in a systemd Debian 12 container); a **sign-in
  allowlist and Access screen** for admins (DECISIONS §17). Next: Phase 4. Phase 4 (definition editors) after that.
- Phases 4-5 — see `PLAN.md`

Not yet verified anywhere: the Discord OAuth **callback** (needs a real Discord
app), the definition forms in a browser, and a real-cache project in the e2e
suite (it builds an empty one). An exported cache, with a replaced texture, has
been loaded by the 2003scape web client (rsc-client, 204) and drawn on its
title screen; play past login has not been checked by the editor's tests.

**NPCs, ground items and doors** are per-sector entities beside the lanes
(DECISIONS §19): NPC and Item tools, a server-door option on Walls, imported with
`--spawns`, exported as the game server's three lists.

**The asset library** (models, textures, NPC and item sprites) lives beside
the definitions (DECISIONS §20): browse, upload, replace, reorder and delete from
the Assets screen, references rewritten server-side, archives patched on export.

**The `.hei` format only holds even elevation and colour values** (DECISIONS
§15). Anything that writes those lanes must go through `clampLane`.
