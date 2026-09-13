# Scenery placements

## `object-locs.json`

Where every tree, fence, table and signpost in the world actually stands.

- **Source**: [`2003scape/rsc-landscape`](https://github.com/2003scape/rsc-landscape), `object-locs.json` at the repo root
- **Retrieved**: 2026-09-13
- **Checksum**: `object-locs.sha256`
- 3,238,599 bytes — **26,902 placements**, 989 distinct object ids, 342 sectors, all 8 directions

```jsonc
[ { "id": 1, "position": [346, 554], "direction": 0 } ]
```

`position` is game coordinates, not sector-local. `id` indexes `config.objects`.

## Why this is not in the cache

Because RuneScape Classic does not put it there.

The landscape archives contain exactly **two** `.loc` entries — `m05049` and
`m05050`, which rsc-landscape's own source calls "the sectors shown in login".
That is Lumbridge, and it is the login screen backdrop. Every other sector in
the shipped cache has no scenery data at all.

In the real game the server tells the client what scenery exists, the same way
it does for NPCs and ground items. The map archives carry terrain, walls, roofs
and overlays; everything that moves or can be interacted with is server-side.

This bit us: the `wallsDiagonal` lane genuinely does encode scenery ids above
48000 (DECISIONS §2), which makes the cache *look* like it stores scenery. It
stores scenery for two sectors.

## How it is used

Importing it is a **separate, explicit step** (`--scenery`), never part of a
plain cache import. That split is deliberate:

- a plain cache import stays byte-exact against the source archives, which is
  the guarantee the whole project is built on and which is provable only if
  nothing else is mixed in;
- adding scenery is then a decision someone makes, with a visible flag.

Once imported it is written into the `wallsDiagonal` lane as
`objectId + 48001`, which is the cache's own encoding — so the renderer, the
scenery tool, the op log, locking and undo all work on it unchanged, with no
second code path.

The cost, stated plainly: an export of a scenery-imported project writes `.loc`
entries for sectors the original cache did not have them for. That is harmless
to a real client, which only reads `.loc` for the login screen, but it means
such an export is no longer byte-identical to the cache it came from. Import
without `--scenery` if byte-identical export is what you need.
