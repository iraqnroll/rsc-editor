#!/usr/bin/env bash
# Install an RSC Editor export (zip or directory) into a 2003scape game:
#   - every .jag/.mem goes to the web client's cache  (rsc-client/dist/data204)
#   - land/maps archives also go to the server        (rsc-data/landscape)
#   - object-locs.json is reshaped for the server     (rsc-data/locations/objects.json)
#   - npcs.json, items.json and wall-objects.json, when the project has placements,
#     replace the server's lists; otherwise stock doors in changed sectors are dropped
#   - config-*.json are the definitions (npcs, items, objects, walls, ...) and
#     replace the server's own copies in rsc-data/config
#
#   GAME_DIR=/opt/rsc-game bash load-cache.sh export.zip
#   GAME_DIR=/opt/rsc-game bash load-cache.sh --restore     # the stock 204 data back
#
# GAME_DIR holds rsc-client/ and rsc-server/ checkouts. STOCK_DIR (default
# $GAME_DIR/stock-data) is where the first run keeps the stock files.
#
# Used by deploy/game/publish.sh on the game host, and by hand anywhere else.
# rsc-server only reads these at startup, so restart it afterwards.
# `npm install` in rsc-server replaces node_modules, so run this again after one.
set -euo pipefail

ROOT="${GAME_DIR:?set GAME_DIR to the directory holding rsc-client/ and rsc-server/}"
CLIENT_CACHE="$ROOT/rsc-client/dist/data204"
DATA="$ROOT/rsc-server/node_modules/@2003scape/rsc-data"
BACKUP="${STOCK_DIR:-$ROOT/stock-data}"

# First run: keep the stock files so --restore can undo everything.
if [[ ! -d "$BACKUP" ]]; then
  mkdir -p "$BACKUP/data204" "$BACKUP/landscape"
  cp "$CLIENT_CACHE"/* "$BACKUP/data204/"
  cp "$DATA/landscape"/* "$BACKUP/landscape/"
  cp "$DATA/locations/objects.json" "$BACKUP/objects.json"
fi
# Added later than the rest of the backup; these files are still stock at that point.
for f in wall-objects npcs items; do
  [[ -f "$BACKUP/$f.json" ]] || cp "$DATA/locations/$f.json" "$BACKUP/$f.json"
done
# The definitions the SERVER reads. It never opens config<n>.jag: names, examine
# text, stats and door/object behaviour all come from these, so an NPC renamed in
# the editor stayed "Hans" in game until they were replaced too.
if [[ ! -d "$BACKUP/config" ]]; then
  mkdir -p "$BACKUP/config"
  cp "$DATA/config"/*.json "$BACKUP/config/"
fi

if [[ "${1:-}" == "--restore" ]]; then
  cp "$BACKUP/data204"/* "$CLIENT_CACHE/"
  cp "$BACKUP/landscape"/* "$DATA/landscape/"
  cp "$BACKUP/objects.json" "$DATA/locations/objects.json"
  for f in wall-objects npcs items; do cp "$BACKUP/$f.json" "$DATA/locations/$f.json"; done
  cp "$BACKUP/config"/*.json "$DATA/config/"
  echo "restored stock data -- restart the game server"
  exit 0
fi

# rsc-landscape drops any sector it thinks is empty, and its test misses real data:
# heights/colours >= 128 read as negative from its Int8Arrays (`> 0` fails), and
# overlays never count. A flat, overlay-only sector from the editor vanished from
# the server -- with its collision and every object on it -- while the client drew it.
# Idempotent; re-applied on every run because `npm install` restores the original.
for f in "$ROOT"/rsc-server/node_modules/@2003scape/rsc-landscape/src/sector.js; do
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    let src = fs.readFileSync(file, "utf8");
    if (src.includes("rsc-game patch")) process.exit(0);
    const swaps = [
      ["if (this.terrainHeight[index] > 0) {", "if (this.terrainHeight[index] !== 0) { // rsc-game patch"],
      ["if (this.terrainColour[index] > 0) {", "if (this.terrainColour[index] !== 0) { // rsc-game patch"],
      ["this.tileDecoration[tile++] = val & 0xff;\n                lastVal = val;",
       "this.tileDecoration[tile++] = val & 0xff;\n                lastVal = val;\n                if (val > 0) this.empty = false; // rsc-game patch"],
      ["this.tileDecoration[tile++] = lastVal;",
       "this.tileDecoration[tile++] = lastVal;\n                    if (lastVal > 0) this.empty = false; // rsc-game patch"]
    ];
    for (const [from, to] of swaps) {
      if (!src.includes(from)) { console.error(`rsc-landscape changed, patch not applied: ${from}`); process.exit(1); }
      src = src.replace(from, to);
    }
    fs.writeFileSync(file, src);
    console.log("patched rsc-landscape: flat and overlay-only sectors are kept");
  ' "$f"
done

SRC="${1:?usage: load-export.sh <export.zip|dir> | --restore}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [[ -d "$SRC" ]]; then
  cp -R "$SRC"/. "$WORK/"
else
  unzip -q -o -j "$SRC" -d "$WORK"
fi

shopt -s nullglob
archives=("$WORK"/*.jag "$WORK"/*.mem)
[[ ${#archives[@]} -gt 0 ]] || { echo "no .jag/.mem files in $SRC" >&2; exit 1; }

cp "${archives[@]}" "$CLIENT_CACHE/"
echo "client cache: ${#archives[@]} files -> rsc-client/dist/data204"

# rsc-server hard-codes land63/maps63 (src/model/world.js), whatever the export calls them.
for kind in land maps; do
  for ext in jag mem; do
    f=("$WORK"/${kind}[0-9]*.${ext})
    if [[ ${#f[@]} -gt 0 ]]; then
      cp "${f[0]}" "$DATA/landscape/${kind}63.${ext}"
      echo "server landscape: $(basename "${f[0]}") -> ${kind}63.${ext}"
    fi
  done
done

# Definitions: config-npcs.json -> rsc-data/config/npcs.json, and so on. These
# are what the server answers with for a name, an examine or a door's behaviour;
# the client reads the same definitions out of config<n>.jag, which went to
# dist/data204 above. Both sides have to move together or they disagree.
defs=0
for f in "$WORK"/config-*.json; do
  name="$(basename "$f")"
  name="${name#config-}"
  cp "$f" "$DATA/config/$name"
  defs=$((defs + 1))
done
if [[ $defs -gt 0 ]]; then
  echo "server definitions: $defs files -> rsc-data/config"
else
  echo "no config-*.json in the export -- server definitions left as they were"
  echo "  (export again with a current editor: names and stats will stay stock)"
fi

if [[ -f "$WORK/object-locs.json" ]]; then
  # Same placements, different shape: {id, position:[x,y], direction} -> {id, direction, x, y}.
  node -e '
    const fs = require("fs");
    const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      .map((o) => ({ id: o.id, direction: o.direction, x: o.position[0], y: o.position[1] }));
    fs.writeFileSync(process.argv[2], JSON.stringify(rows) + "\n");
    console.log(`server objects: ${rows.length} placements`);
  ' "$WORK/object-locs.json" "$DATA/locations/objects.json"
else
  echo "no object-locs.json in the export -- server objects left as they were"
fi

if [[ -f "$WORK/npcs.json" && -f "$WORK/items.json" && -f "$WORK/wall-objects.json" ]]; then
  # The project carries its own NPCs, items and doors: they replace the server's.
  for f in npcs items wall-objects; do
    cp "$WORK/$f.json" "$DATA/locations/$f.json"
    echo "server $f: $(node -e 'console.log(require(process.argv[1]).length)' "$WORK/$f.json") from the export"
  done
  echo "done -- restart the game server, and hard-refresh the browser (Cmd+Shift+R)"
  exit 0
fi
# The server's own NPC and item lists stay as they are.
for f in npcs items; do cp "$BACKUP/$f.json" "$DATA/locations/$f.json"; done

# Doors are a server-side list the export does not carry, and the server writes
# each one into the map as a wall. A stock door inside a sector the export
# CHANGED would be an invisible wall on the new map, so it goes; doors in
# unchanged stock sectors (a whole-world export has all of them) stay.
(cd "$ROOT/rsc-server" && node -e '
  const fs = require("fs");
  const { Landscape } = require("@2003scape/rsc-landscape");
  const [dir, stockDir, stockDoors, out] = process.argv.slice(1);
  const load = (d) => {
    const land = new Landscape();
    land.loadJag(fs.readFileSync(d + "/land63.jag"), fs.readFileSync(d + "/maps63.jag"));
    land.loadMem(fs.readFileSync(d + "/land63.mem"), fs.readFileSync(d + "/maps63.mem"));
    land.parseArchives();
    return land;
  };
  const mine = load(dir);
  const stock = load(stockDir);
  const LANES = ["terrainHeight", "terrainColour", "tileDirection", "tileDecoration",
    "wallsVertical", "wallsHorizontal", "wallsRoof", "wallsDiagonal"];
  const sectorAt = (land, x, y) => {
    try { return land.getTileAtGameCoords(x, y).sector; } catch { return undefined; }
  };
  const changed = (x, y) => {
    const a = sectorAt(mine, x, y);
    if (!a) return false;
    const b = sectorAt(stock, x, y);
    if (!b) return true;
    return LANES.some((lane) => a[lane].some((v, i) => v !== b[lane][i]));
  };
  const doors = JSON.parse(fs.readFileSync(stockDoors, "utf8"));
  const kept = doors.filter((d) => !changed(d.x, d.y));
  fs.writeFileSync(out, JSON.stringify(kept) + "\n");
  console.log(`server doors: dropped ${doors.length - kept.length} stock doors inside changed sectors`);
' "$DATA/landscape" "$BACKUP/landscape" "$BACKUP/wall-objects.json" "$DATA/locations/wall-objects.json")

echo "done -- restart the game server, and hard-refresh the browser (Cmd+Shift+R)"
