# RSC Editor

Collaborative web-based RuneScape Classic map & cache editor. Multiple people
log in, claim 48x48 sectors, and edit terrain/walls/roofs/scenery with a
client-accurate 3D preview.

Read `docs/DECISIONS.md` before touching the cache codec, the dependency
pins, or the definition schemas. It records findings that cost real time.

## Commands

```sh
pnpm install
pnpm test            # all packages
pnpm typecheck       # REQUIRED before claiming done -- see below
pnpm build
pnpm dev
```

Per-package: `pnpm --filter @rsc-editor/cache test`

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
must keep all 594 files byte-exact.

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
- Phase 1 (cache fidelity gate) — **passed**, 594/594 byte-exact
- Phase 2 (cache pkg, db+api+auth, static 3D renderer, UI shell) — next
- Phases 3-5 — see `PLAN.md`

Docker is not yet installed on this machine; Phase 2 needs it for Postgres.
