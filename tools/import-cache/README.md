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
leaves exactly the same rows; the summary reports `0 written, 17 already
current`.

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
  an export can be diffed against its import; the `config.models` name table as
  `models.index.json`; and the texture atlas as `texture-atlas.png` plus
  `texture-atlas.layout.json`, which
  `apps/server/src/routes/cache-assets.ts` serves.

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
