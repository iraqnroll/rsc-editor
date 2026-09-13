# RSC Editor

A collaborative, web-based map and cache editor for **RuneScape Classic**.

Several people log in, claim 48×48 sectors, and edit terrain, walls, roofs and
scenery together — with a 3D preview that matches what the game client actually
renders, not an approximation of it.

Existing RSC editors are single-user desktop tools. This one is built around
concurrent editing from the ground up.

## Status

| Phase | State |
|---|---|
| 0 — Foundations, frozen contracts | done |
| 1 — Cache fidelity gate | **passed** — 594/594 files byte-exact |
| 2 — Cache assets, renderer, API/DB, editor shell | in progress |
| 3–5 — Editing + realtime, definitions, export | see [`PLAN.md`](PLAN.md) |

## Why the fidelity gate came first

`.hei` and `.dat` store terrain as delta + run-length encodings whose quirks
decide whether real maps survive a round trip. Proving that before building
anything on top surfaced a genuine data-corruption bug in the reference
library — one that is invisible when you read your own output back, and which
would have silently mangled every exported cache containing scenery.

The details, and everything else that cost real time to work out, are in
[`docs/DECISIONS.md`](docs/DECISIONS.md). Read it before touching the codec.

## Layout

```
packages/schema   frozen Zod contracts: lanes, wire format, ops, protocol, defs
packages/cache    the landscape codec + config definitions (byte-exact)
packages/render   RSC geometry & shading, framework-agnostic
packages/db       Drizzle schema + migrations
apps/server       Fastify API + WebSocket realtime
apps/web          React + react-three-fiber editor
fixtures/         the real mudclient204 cache -- read-only, see SOURCE.md
```

## Getting started

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm typecheck    # not optional -- see DECISIONS.md section 7
pnpm test
pnpm dev
```

Postgres (via Docker) is needed from Phase 2 onward.

## Built on

The [2003scape](https://github.com/2003scape) toolchain —
[`rsc-archiver`](https://github.com/2003scape/rsc-archiver),
[`rsc-config`](https://github.com/2003scape/rsc-config),
[`rsc-landscape`](https://github.com/2003scape/rsc-landscape) and
[`rsc-client`](https://github.com/2003scape/rsc-client), the last of which is
the reference for client-accurate rendering.

## Licence

MIT, for the editor's own source. The cache fixtures under `fixtures/` are
Jagex-copyrighted game assets included as test data and are not covered by it.
