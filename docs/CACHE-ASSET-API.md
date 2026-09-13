# Cache asset API

Frozen contract for the assets the importer builds and the browser consumes.
Three workstreams are implemented against this simultaneously, so **do not
change a path or a payload shape here without saying so** — the whole point is
that the producer and the consumers can be written at the same time.

All routes:

- live under `/api/projects/:projectId/cache-assets/…`
- require `projectGuard(ctx, 'viewer')`
- carry an `ETag` and honour `if-none-match` with a 304, like the sector route
- answer **404 when the asset has not been imported**, which is a normal state
  for a fresh project and must not be treated as an error by the client

Existing, already shipped:

| route | type |
|---|---|
| `…/texture-atlas` | `image/png` |
| `…/texture-atlas/layout` | `application/json` |

## New: scenery models

```
GET …/cache-assets/models          -> application/json, content-encoding: gzip
```

Every `.ob3` model in the cache, decoded, keyed by **name** — never by
`objectDef.model.id`, which is off by one for the first object mentioning each
name (DECISIONS §8).

```jsonc
{
  "models": {
    "tree2": {
      "vertices": [ { "x": 0, "y": -240, "z": 0 }, … ],   // integers, client space
      "faces": [
        {
          "vertices": [0, 1, 2],                          // indices into `vertices`
          "fillFront": { "colour": 3100 } | { "texture": 12 } | null,
          "fillBack":  { "colour": 3100 } | { "texture": 12 } | null,
          "illuminated": true
        }
      ]
    }
  },
  "missing": ["runiteruck1"]     // named in config, absent from the archive
}
```

Stored gzipped as a cache asset; the route sets `content-encoding: gzip` so the
browser inflates it transparently. Uncompressed this is several MB and it is
fetched once per session.

`fillFront`/`fillBack` of `null` means that side is not drawn. A `texture` of
`0` is a real texture, not an absence — check the shape, never truthiness.

## New: world map

```
GET …/cache-assets/world-map/:plane        -> image/png
GET …/cache-assets/world-map/:plane/meta   -> application/json
```

A coloured top-down map of one plane at **one pixel per tile**, drawn the way
the game's own world map looks: terrain colour ramp, overlays (water, road,
floor) over the top, walls and scenery marked. The populated region is only
about 17×19 sectors, so each plane is roughly 816×912 px.

```jsonc
{
  "plane": 0,
  "originSector": { "x": 48, "y": 37 },   // top-left sector the image covers
  "sectors":      { "width": 17, "height": 19 },
  "tileSize": 1,                           // pixels per tile
  "image":        { "width": 816, "height": 912 }
}
```

The client maps a sector to image pixels as
`((sx - originSector.x) * 48 * tileSize, (sy - originSector.y) * 48 * tileSize)`.

Pixel orientation must match the editor's existing minimap: x increases right,
y increases down, same as `sectorKey` ordering. Say so in a test.

## New: entity sprites

```
GET …/cache-assets/entity-sprites          -> image/png
GET …/cache-assets/entity-sprites/layout   -> application/json
```

Item and NPC sprites packed into one sheet, for the definition editors and
pickers. Same layout shape as the texture atlas, keyed by sprite index.

As built: the sheet is **4096×2830** with **4,599 cells** — 450 item sprites and
1,143 animation frames.

```jsonc
{
  "sheet": { "width": 4096, "height": 2830 },
  "cells": [ { "spriteId": 0, "x": 0, "y": 0, "width": 32, "height": 32 } ],
  // optional: NPC index -> a sprite id to show as its icon
  "npcs": { "0": 1234 }
}
```

Sprite ids:

- **items** are `ItemDef.sprite` verbatim (0–449), so an item definition looks
  its own icon up with no indirection.
- **animation frames** are `1000 + animationIndex * 27 + frame`, following the
  client's own `j+15` / `j+18` slot layout (15 base, "a" at 15, "f" at 18). The
  arithmetic means a missing set never renumbers another slot.

`npcs` is additive and optional. `NpcDef` carries animation indices rather than a
sprite, so without it the NPC editor has nothing to show; a client that does not
understand it must fall back to no icon rather than failing.

### Where the sprites actually live

Item sprites are **not** in `entity24.jag`, which holds only animation sprites.
They are `objects1.dat` … `objects15.dat` in **`media58.jag`**, thirty frames
each. Established by accounting for every archive entry rather than by guessing:
all 109 `entity24.jag` and 18 `entity24.mem` entries are `index.dat` or an
animation, with nothing left over.

The **frame count per entry is stored nowhere** — the client passes it in at each
call site. The counts (15 base / 3 "a" / 9 "f" per animation, 30 per item file)
are proved by showing they consume each entry's payload exactly. Reading one
frame too many walks into the next group's header and yields a plausible sprite
of nonsense, so the decoder bounds-checks before allocating.

### What is deliberately NOT here

**NPC and ground-item placements.** The landscape lanes carry elevation,
colour, overlay, direction, walls and scenery object ids — and nothing else.
There are no NPC or item spawn positions anywhere in the cache; in the
2003scape ecosystem those live in server data (`rsc-data`), not in the map
archives.

So entity sprites exist to make the item and NPC **definition editors** usable,
not to populate the world. Placing NPC spawns is a future editor feature backed
by our own database, and it should not be presented as if it came from the
cache.
