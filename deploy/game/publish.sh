#!/usr/bin/env bash
# Install a cache the editor published, then restart the game. Run as root by
# rsc-game-publish.service, which rsc-game-publish.path starts when the editor
# drops a request in the inbox:
#
#   /var/lib/rsc-game/inbox/cache.zip      written first (by rename)
#   /var/lib/rsc-game/inbox/request.json   written second: "go"
#
# The editor never gets root or touches the game; this script reports back to
# it through /var/lib/rsc-game/status.json (apps/server routes/publish.ts).
set -euo pipefail

PUB=/var/lib/rsc-game
INBOX="$PUB/inbox"
WORK="$PUB/work"
GAME_DIR=/opt/rsc-game
GAME_USER=rscgame
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ -f "$INBOX/request.json" ]] || exit 0

# Take the request out of the inbox first: the path unit fires again for as
# long as request.json exists, and the editor refuses a second publish while
# status.json says "running".
rm -rf "$WORK"
mkdir -p "$WORK"
mv "$INBOX/request.json" "$WORK/request.json"
[[ -f "$INBOX/cache.zip" ]] && mv "$INBOX/cache.zip" "$WORK/cache.zip"
: > "$WORK/log"

# status <state> [message]: status.json = the request + state + times, by rename.
status() {
  node -e '
    const fs = require("fs");
    const [requestFile, out, state, message, startedAt] = process.argv.slice(1);
    const r = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    const s = { id: r.id, state, project: r.project, requestedBy: r.requestedBy, startedAt };
    if (state !== "running") s.finishedAt = new Date().toISOString();
    if (message) s.message = message;
    fs.writeFileSync(out + ".tmp", JSON.stringify(s, null, 2) + "\n");
    fs.renameSync(out + ".tmp", out);
  ' "$WORK/request.json" "$PUB/status.json" "$1" "${2:-}" "$STARTED"
  chmod 0644 "$PUB/status.json"
}

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
status running

DATA="$GAME_DIR/rsc-server/node_modules/@2003scape/rsc-data"
CLIENT_CACHE="$GAME_DIR/rsc-client/dist/data204"
PREVIOUS="$PUB/previous"
INSTALLED=0

# What the game runs now, so a publish that breaks it can be taken back.
snapshot() {
  rm -rf "$PREVIOUS"
  mkdir -p "$PREVIOUS"
  cp -a "$CLIENT_CACHE" "$PREVIOUS/data204"
  for d in landscape locations config; do cp -a "$DATA/$d" "$PREVIOUS/$d"; done
}

rollback() {
  echo "== rolling back to the previous cache" >>"$WORK/log"
  cp -a "$PREVIOUS/data204/." "$CLIENT_CACHE/"
  for d in landscape locations config; do
    rm -rf "${DATA:?}/$d"
    cp -a "$PREVIOUS/$d" "$DATA/$d"
  done
  systemctl restart rsc-game.service >>"$WORK/log" 2>&1 || true
}

fail() {
  trap - ERR
  if [[ $INSTALLED -eq 1 ]]; then rollback; fi
  # The last lines of the log say what went wrong; the rest is in the journal.
  status failed "$1: $(tail -n 5 "$WORK/log" | tr '\n' ' ' | cut -c1-600)"
  echo "publish failed: $1" >&2
  cat "$WORK/log" >&2
  exit 1
}
trap 'fail "unexpected error on line $LINENO"' ERR

[[ -f "$WORK/cache.zip" ]] || fail "the request came without a cache.zip"

# An export is a flat directory of plain file names. Anything else -- a path,
# a dot-dot, a directory -- is not something the editor made.
if unzip -Z1 "$WORK/cache.zip" | grep -qvE '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
  fail "cache.zip holds something other than plain file names"
fi

snapshot
echo "== install $(node -p 'require(process.argv[1]).project' "$WORK/request.json")" >>"$WORK/log"
GAME_DIR="$GAME_DIR" STOCK_DIR="$PUB/stock" \
  bash "$HERE/load-cache.sh" "$WORK/cache.zip" >>"$WORK/log" 2>&1 \
  || { INSTALLED=1; fail "installing the cache failed"; }
INSTALLED=1
chown -R "$GAME_USER:$GAME_USER" \
  "$GAME_DIR/rsc-client/dist/data204" \
  "$GAME_DIR/rsc-server/node_modules/@2003scape/rsc-data" \
  "$GAME_DIR/rsc-server/node_modules/@2003scape/rsc-landscape"

echo "== restart" >>"$WORK/log"
systemctl restart rsc-game.service >>"$WORK/log" 2>&1 || fail "the game server did not restart"

# rsc-server reads the whole world before it listens, so "listening" is the
# signal that the new cache loaded rather than crashed it.
for _ in $(seq 60); do
  if ss -ltn 2>/dev/null | grep -q ':43595 '; then
    trap - ERR
    # install.sh reinstalls this after an npm install puts stock data back.
    cp "$WORK/cache.zip" "$PUB/current.zip"
    summary="$(grep -E '^(client cache|server )' "$WORK/log" | tr '\n' ';' | sed 's/;$//' | cut -c1-600)"
    status done "$summary"
    echo "published: $summary"
    exit 0
  fi
  if ! systemctl is-active --quiet rsc-game.service; then break; fi
  sleep 1
done
journalctl -u rsc-game.service -n 5 --no-pager >>"$WORK/log" 2>&1 || true
fail "the game server did not come back up with the new cache"
