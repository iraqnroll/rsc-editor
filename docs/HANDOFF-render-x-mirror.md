# Handoff: the render x mirror (east is now on the right)

> **`DECISIONS.md` §13 is the canonical statement of *why*.** This file is the
> implementation record: the derivation, the module-by-module changes, and the
> test expectations that moved. If the two ever disagree, §13 wins and this file
> is stale.
>
> Kept separate on purpose. DECISIONS holds findings that change how you work;
> a walkthrough of which files call `renderX` would bury them.

Written at the end of the session that made the change. Everything below is done
and green unless it says otherwise. Read the "Do not undo this by halves"
section before touching any sign in the render path.

State at handoff: **594 tests pass repo-wide** (588 before, +6 new), `pnpm -r
typecheck` clean, `pnpm --filter @rsc-editor/web build` clean.

---

## 1. What was wrong, and the correction that matters most

The decision was: make the 3D view match the world map — north up, east right.

The earlier analysis (in a now-deleted comment on `MAP_NORTH_YAW`) said this was
impossible without giving up fidelity to the client, because "mudclient is
mirrored too, and `packages/render` is a faithful port of it". **That was wrong**,
and it is the single most useful thing to carry forward:

> mudclient is **not** mirrored. `GameModel#project` divides by z with no sign
> games, so at identity camera rotation the client's screen right is `+x` (west)
> while it looks along `+z` (south) — and facing south, west *is* on your right.
> Turn the camera north and east comes round to the right, exactly as the map
> draws it.
>
> What was mirrored was `packages/render`'s **render space**. The client's "up"
> is `-y` (`setCamera(x, -elevation, z, ...)`, terrain corners at `-height`), so
> building a Y-up space for three.js meant `diag(1, -1, 1)` — a reflection,
> determinant −1. `RscModel.build` compensated the *winding*, which keeps
> one-sided surfaces showing the correct face but does **not** undo the mirror of
> the picture.
>
> Negating x as well makes the whole map `diag(-1, -1, 1)`, determinant +1: a
> plain 180° rotation about the vertical, with no reflection left anywhere.

So matching the map did not cost fidelity to the client — it **restored** it. The
editor was previously a mirror image of both. `docs/DECISIONS.md` §13 is being
updated with this; if it has not landed yet, that quote is the text.

## 2. The new coordinate contract

```
render x = RENDER_X_SIGN * gameX * TILE_SIZE     (+x is EAST; RENDER_X_SIGN = -1)
render y = -clientY                              (+y is UP)
render z = gameY * TILE_SIZE                     (+z is SOUTH)
```

`(East, North, Up) = (+x, -z, +y)` is right-handed (`x × -z = +y`), which is why
one camera yaw now satisfies both halves of the map's orientation.

**World x is negative.** A sector at sector-x 50 spans render x −307200…−313344.
That is expected, not a bug.

## 3. Where the mirror lives

| Thing | File |
|---|---|
| The constant, helpers and the full rationale | `packages/render/src/render-space.ts` |
| The one place geometry is mirrored + winding reversed | `packages/render/src/model.ts`, `RscModel.build` → `emitFace` |
| The 2D fallback's whole screen transform | `apps/web/src/scene/fallback-view.ts` |

`render-space.ts` exports `RENDER_X_SIGN`, and `renderX` / `tileRenderX` /
`renderXToTile`. `renderX` is an **involution** (`renderX(renderX(v)) === v`), so
the same function converts both ways and there is no second function to drift.
All three are re-exported from `@rsc-editor/render`.

### Do not undo this by halves

Three expressions in `emitFace` are written in terms of `RENDER_X_SIGN`:

```ts
const reverse = isFront === (RENDER_X_SIGN > 0);              // winding
const rawNX   = RENDER_X_SIGN * lit.faceNormalX[faceIndex]!;  // drawn-side normal
positions.push(renderX(this.vertexX[v]!), -this.vertexY[v]!, this.vertexZ[v]!);
```

Setting `RENDER_X_SIGN` back to `+1` restores the old space **consistently**.
Editing one of the three without the others produces geometry that is inside
out — roofs visible only from underneath, walls only from inside — which looks
like the inside of a bag and passes every count-based test in the package.

The derivation, if you need it: render space is client space through
`T = diag(RENDER_X_SIGN, -1, 1)`, so `det(T) = -RENDER_X_SIGN`. Emitting the
source vertex order gives a right-hand-rule normal of `det(T) · T⁻ᵀ · n`, while
the side the client draws is `+T⁻ᵀ·n` for a front fill and `-T⁻ᵀ·n` for a back
fill. They agree — i.e. the drawn side is the three.js front face — exactly when
`(isFront ? 1 : -1)` equals `-RENDER_X_SIGN`; otherwise reverse. A "which side is
visible" normal is a half-space test, so it maps by `T⁻ᵀ` with **no** determinant
factor, which is why the normal and the winding use different rules.

## 4. Everything that had to follow

Anything converting a game coordinate to a render position — or a render
position back to a tile — goes through `renderX`. Nothing else got a private
sign.

- `packages/render/src/scenery.ts` — `resolveScenery` mirrors `instance.x`. Note
  `view.elevation(x, z)` keeps the **unmirrored** value: it is a lane read.
- `packages/render/src/connectors.ts` — `listConnectors` mirrors once, on the
  full game-space x. Marker diamonds are symmetric, so they needed nothing.
- `packages/render/src/model-preview.ts` — `modelBounds` now mirrors x. It
  claimed render space and read raw client x; off-centre models (shop signs,
  fence posts) would have been framed on the mirror image of their own geometry.
- `apps/web/src/scene/camera.ts` — `sectorCentre` / `tileCentre`. The camera
  *arithmetic* (`orbitPose`, `panBy`, `flyForward`) is untouched: the mirror is
  in the geometry, not the view.
- `apps/web/src/scene/sector-geometry.ts` — the sector group origin `originX`,
  and `WorldHeights.at` (which takes a render x and must un-mirror before
  indexing lanes).
- `apps/web/src/scene/overlay-geometry.ts` — grid, sector borders, selection,
  brush, lock tint.
- `apps/web/src/scene/picking.ts` — `worldTileAt` uses `renderXToTile`.
  `tileOfFace` is **unaffected**: `triangleTiles` is an index, not a coordinate.
- `apps/web/src/scene/FallbackViewport.tsx` + `fallback-view.ts` — see §6.

`Viewport3D.tsx` needed no coordinate edits; everything it positions comes from
the modules above.

## 5. How it is pinned (and why counts cannot do it)

Counting triangles, or checking `sectorCentre` against `renderX`, cannot see a
mirror — it is the mirror checking itself. That is the whole lesson of the world
map bug (DECISIONS §13). Both acceptance tests therefore use a judge **outside**
our own arithmetic.

**3D** — `apps/web/src/scene/scene.test.ts` → `cameras > puts east on the right,
the way the world map does`. Pushes two tiles through the real
`orbitPose(...MAP_NORTH_YAW...)` and three's own `project()`, and asserts the
smaller game x lands at a larger screen x — matching the map's published
contract `pixelX = width - 1 - gameX`. Verified: with `RENDER_X_SIGN = +1` this
test and *only* this test fails (`-0.1729 > 0.1729`); the other 36 scene tests
stay green.

**One-sidedness** — `packages/render/src/preview.test.ts` already had the
orientation tests and they still pass **with the cull directions untouched**
(`'ccw'` for the correct face, `'cw'` for the reverse). `winding-front.png` is
199 KB, `winding-back.png` 8.9 KB, `from-below.png` nearly empty. That is the
proof the winding reversal is right rather than compensated for.

**2D fallback** — five tests under `the 2D fallback viewport`, judged against
`apps/web/src/data/world-map.ts`. The setup makes it exact rather than
directional: a canvas showing one 48×48 sector at 4 px/tile *is*, pixel for
pixel, a world map image of that sector at `tileSize: 4`, so the assertions are
equality against `tileToMap` / `sectorToMap` / `mapToTile`.

Both fallback failure modes were verified, with the file restored byte-identical
each time:

| Injected fault | What failed |
|---|---|
| The exact pre-mirror transform | the 3 map-judged tests — **pan and zoom passed** |
| Half-applied flip (draw+pick mirrored, pan+zoom left behind) | pan and zoom — **the 3 map-judged tests passed** |

Disjoint sets, and neither alone is sufficient. Keep both.

**Eyeball** — `packages/render/preview/*.png` are regenerated by the test run.
`planes-cutaway.png` (Lumbridge castle, first floor over ground floor, ladders
linking them), `textured-oblique.png`, `model-thumbnails.png`,
`scenery-directions-chair.png` all read correctly. The decisive one was a scratch
render of sectors 49–51 × 49–51 through the editor's own
`sectorCentre(50,50)` + `MAP_NORTH_YAW` preset: unmistakably Lumbridge, north up,
castle on the left, River Lum to its right with both bridges, **and the Al Kharid
desert on the right edge** — east of the river, exactly where the map puts it.
Before the mirror the desert was on the left. (That scratch file was deleted; it
is easy to recreate as a temporary `*.test.ts` in `packages/render/src/`.)

## 6. The 2D fallback

`apps/web/src/scene/fallback-view.ts` is new and holds the whole transform:
`cornerToScreenX`, `tileToScreen`, `screenToTile`, `panView`, `zoomView`,
`visibleTiles`. It takes its sign from the shared `renderX`:

```ts
function mirrorCols(tiles: number): number {
  return renderX(tiles * TILE_SIZE) / TILE_SIZE;   // the factors cancel exactly
}
```

Written that way — rather than a bare `-` — so it cannot survive a change to
`renderX` that it disagrees with. One mirror in the repo, not two.

Three things there changed **side**, not just sign, and are the likely sites of
any future bug:

- **`tileToScreen` takes a width in tiles.** Mirrored, a rect grows *leftward*
  from its origin column, so its left edge is the corner at `wx + tilesX`. A
  48-tile sector border and a 1-tile cell no longer start at the same pixel;
  defaulting it for the sector border puts the outline 47 tiles away.
- **Vertical walls moved to the other edge.** `wallsVertical(x,y)` spans corners
  (x,y)–(x,y+1) — grid column x — which mirrored is the tile's **right** edge.
- **The two diagonal rotations swapped**, which is just what a mirror does to a
  diagonal.

The pick inverse is `ceil(...) - 1`, not `floor`, matching `mapToTile`: mirrored,
a cell is half-open at its *right* edge. `floor` puts every click one tile too
far west — invisible at 1.5 px/tile, maddening at 24.

What is deliberately **not** mirrored there: `view.cx`/`cy`, the lane reads, the
recentre-on-sector effect, the hillshade gradient, and `visibleTiles` (the window
is symmetric about the centre tile, so reversing the axis does not change which
tiles are on screen — that is the obvious wrong guess).

## 7. Tests whose expectations were updated, and why each was legitimate

All are absolute-position or camera-placement facts that genuinely moved. None
was weakened; several were rewritten to keep reading in **tiles** rather than in
raw render units.

- `packages/render/src/test-support.ts` — `sharedEdge` now reports
  `renderX(c[0])/128`. It returns **grid columns**; without this every diagonal
  assertion reads `-20,21` and hides what the test is about.
- `terrain.test.ts` (4 sites), `walls.test.ts` (the `at()` helper),
  `scenery.test.ts` (3), `connectors.test.ts` (1) — `tileRenderX` / `renderX` on
  x only.
- `preview.test.ts`, `textured-preview.test.ts`, `scenery-preview.test.ts`,
  `multi-plane-preview.test.ts` — camera x and the `place()` origin. These were
  aimed at the unmirrored column, i.e. at empty space. **`multi-plane-preview`
  was passing by luck before the change**: its unmirrored `originX` put the
  castle ~10,000 units off target and the wide camera still caught >3000
  triangles. That was a latent bug this exposed.
- `apps/web/src/scene/scene.test.ts` (5 sites) and `scene-perf.test.ts` (1) —
  raycast origins, `tileOfGroundPlane` origin, `worldTileAt` args, brush-corner
  reader. Note off-world is now game x < 0 = render **x > 0**.

## 8. Perf

5×5 sector radius: **123,530 triangles in 111 draw calls** (60 of them scenery,
172 objects), meshed in 1261 ms (50 ms/sector), **pick raycast 0.32 ms/ray**,
200/200 rays resolving to a tile. Printed by
`apps/web/src/scene/scene-perf.test.ts`.

No honest fps figure is available: there is no GPU or browser in the test
workspace. The change adds **zero per-frame work** — one sign flip per vertex at
mesh time — and leaves triangle, draw and instance counts identical, so whatever
the fps was, it still is. The viewport HUD prints the real number.

## 9. Loose ends / suggested next steps

- **`docs/DECISIONS.md` §13** — the correction in §1 above was being written up by
  the coordinator. Check it landed.
- **`docs/CACHE-ASSET-API.md`** — untouched. It documents the *map asset* and is
  still accurate; it says nothing about render space. Worth a cross-reference to
  `render-space.ts` so the two mirrors are findable from each other.
- **`packages/render/src/index.ts`** header now states the +x-is-east contract.
  Any new consumer should be pointed at it.
- Nothing else in the repo converts game coordinates to render positions. If you
  add one, use `renderX` rather than a literal sign.

## 10. Commands

```powershell
$env:PATH = "C:\Users\Lukas\.local\node;$env:PATH"
pnpm -r typecheck
pnpm -r test --run
pnpm --filter @rsc-editor/web build
# previews are written by the render test run, into packages/render/preview/
```

PowerShell 5.1: no `&&`, no ternary, avoid `2>&1` on native exes. Do not
round-trip source files through `Get-Content -Raw` / `Set-Content` — it adds a
BOM and mangles non-ASCII. Use `node -e` for file surgery.
