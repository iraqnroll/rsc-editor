#!/usr/bin/env bash
# Put the RuneScape Classic game beside RSC Editor on the same Debian 12 LXC,
# and wire up the editor's Publish button to it. Run as root, from the
# editor's checkout, after deploy/install.sh:
#
#   bash deploy/game/install.sh --game-url https://game.example.com
#
# Clones the game repository (rsc-client, rsc-server and rsc-data-server in
# one; iraqnroll/rsc-game by default) to /opt/rsc-game, runs it as services,
# serves the client through Caddy, and lets the editor publish into
# /var/lib/rsc-game/inbox.
#
# Running it again deploys the latest commit of the branch it follows: it
# fetches, reinstalls, rebuilds the client, reinstalls the last published
# cache and restarts. Accounts and the generated secrets are kept.
#
#   --repo <git url>   the game repository   (remembered in /etc/rsc-game/source)
#   --ref <branch|sha> what to deploy        (remembered; default main)
set -euo pipefail

GAME_DIR=/opt/rsc-game
PUB=/var/lib/rsc-game
ETC=/etc/rsc-game
EDITOR_ENV=/etc/rsc-editor/server.env
GAME_USER=rscgame
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$SRC_DIR/deploy/game"

DEFAULT_REPO=https://github.com/iraqnroll/rsc-game.git
DEFAULT_REF=main

GAME_URL=""
REPO=""
REF=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --game-url) GAME_URL="${2:?--game-url needs a URL}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs a git URL}"; shift 2 ;;
    --ref) REF="${2:?--ref needs a branch or commit}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -f "$EDITOR_ENV" ]] || { echo "$EDITOR_ENV is missing: install the editor first (deploy/install.sh)" >&2; exit 1; }
id rsc >/dev/null 2>&1 || { echo "no 'rsc' user: install the editor first (deploy/install.sh)" >&2; exit 1; }
command -v node >/dev/null || { echo "node is missing: install the editor first (deploy/install.sh)" >&2; exit 1; }

echo "== packages"
# build-essential + python3: better-sqlite3 and canvas fall back to a source
# build when no prebuilt binary matches this Node.
apt-get install -y git unzip iproute2 build-essential python3

echo "== user and directories"
id "$GAME_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/rscgame --shell /usr/sbin/nologin "$GAME_USER"
install -d -o "$GAME_USER" -g "$GAME_USER" "$GAME_DIR"
install -d -m 0755 -o root -g root "$PUB"
# The editor (user rsc) writes here and nowhere else; publish.sh (root) reads.
install -d -m 0770 -o rsc -g rsc "$PUB/inbox"
install -d -m 0750 -o root -g "$GAME_USER" "$ETC"

as_game() { su "$GAME_USER" -s /bin/bash -c "cd '$1' && HOME=/var/lib/rscgame $2"; }

# What to deploy: the flags, else what the last run used, else the defaults.
SOURCE="$ETC/source"
if [[ -f "$SOURCE" ]]; then
  REPO="${REPO:-$(sed -n 's/^REPO=//p' "$SOURCE")}"
  REF="${REF:-$(sed -n 's/^REF=//p' "$SOURCE")}"
fi
REPO="${REPO:-$DEFAULT_REPO}"
REF="${REF:-$DEFAULT_REF}"
printf 'REPO=%s\nREF=%s\n' "$REPO" "$REF" > "$SOURCE"

echo "== checkout $REPO $REF"
if [[ ! -d "$GAME_DIR/.git" ]]; then
  as_game "$GAME_DIR" "git clone --quiet '$REPO' ."
fi
as_game "$GAME_DIR" "git remote set-url origin '$REPO' && git fetch --quiet --prune origin"
# A branch follows its latest commit; anything else is taken as a commit.
if as_game "$GAME_DIR" "git rev-parse --verify --quiet 'origin/$REF'" >/dev/null; then
  TARGET="origin/$REF"
else
  TARGET="$REF"
fi
# --force and clean: a publish rewrites tracked files (rsc-client/dist/data204)
# in place, and those go back to what the repository ships before the last
# published cache is reinstalled below.
as_game "$GAME_DIR" "git checkout --quiet --force --detach '$TARGET' && git clean -fdq -e node_modules"
echo "deploying $(as_game "$GAME_DIR" "git log -1 --format='%h %s'")"

echo "== npm install"
# A publish rewrites files inside these two packages, and npm install leaves a
# package it finds already installed alone. Remove them so they come back
# exactly as published on npm -- the "stock" taken below depends on it.
rm -rf "$GAME_DIR/rsc-server/node_modules/@2003scape/rsc-data" \
       "$GAME_DIR/rsc-server/node_modules/@2003scape/rsc-landscape"
as_game "$GAME_DIR/rsc-data-server" "npm install --no-audit --no-fund --loglevel=error"
as_game "$GAME_DIR/rsc-server" "npm install --no-audit --no-fund --loglevel=error"
as_game "$GAME_DIR/rsc-client" "npm install --no-audit --no-fund --loglevel=error && npm run --silent build-dev"

echo "== configuration"
if [[ ! -f "$ETC/server.json" ]]; then
  PASSWORD="$(openssl rand -hex 24)"
  HASH="$(cd "$GAME_DIR/rsc-data-server" && node -e 'console.log(require("bcryptjs").hashSync(process.argv[1], 10))' "$PASSWORD")"
  node -e '
    const fs = require("fs");
    const [etc, password, hash] = process.argv.slice(1);
    const server = JSON.parse(fs.readFileSync("/opt/rsc-game/rsc-server/config.json"));
    Object.assign(server, { dataServerFile: "/run/rsc-game/data-server.sock", dataServerPassword: password });
    fs.writeFileSync(etc + "/server.json", JSON.stringify(server, null, 4) + "\n");
    const data = JSON.parse(fs.readFileSync("/opt/rsc-game/rsc-data-server/config.json"));
    Object.assign(data, {
      sockFile: "/run/rsc-game/data-server.sock",
      sqliteFile: "/var/lib/rsc-game-accounts/rsc-data-server.sqlite",
      backupDirectory: "/var/lib/rsc-game-accounts/backups",
      password: hash
    });
    fs.writeFileSync(etc + "/data-server.json", JSON.stringify(data, null, 4) + "\n");
  ' "$ETC" "$PASSWORD" "$HASH"
  chown root:"$GAME_USER" "$ETC"/*.json
  chmod 0640 "$ETC"/*.json
  echo "wrote $ETC/server.json and $ETC/data-server.json"
fi

# Settings that came after a first install, filled in without touching the
# secrets above. The control socket is how the editor's Worlds screen and
# Publish talk to the running world (rsc-server/src/admin).
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const server = JSON.parse(fs.readFileSync(file));
  server.adminSocket = "/run/rsc-game/world-1.sock";
  server.adminSocketMode = "660";
  fs.writeFileSync(file, JSON.stringify(server, null, 4) + "\n");
' "$ETC/server.json"
# The worlds the editor can see. One for now; each entry is a control socket.
if [[ ! -f "$ETC/worlds.json" ]]; then
  echo '[{ "id": "main", "name": "Main world", "socket": "/run/rsc-game/world-1.sock" }]' > "$ETC/worlds.json"
fi
chown root:"$GAME_USER" "$ETC/worlds.json"
chmod 0640 "$ETC/worlds.json"
# The editor's user joins the game's group: that is what lets it open the
# socket (mode 0660) and read worlds.json, and nothing else of the game's.
usermod -aG "$GAME_USER" rsc

echo "== game data"
# The checkout and npm install just produced exactly what the repository
# ships: that is the "stock" a --restore goes back to, so take it afresh each
# time (the repository's own cache may have changed). Then reinstall whatever
# was last published, so a deploy does not quietly roll the game back.
rm -rf "$PUB/stock"
GAME_DIR="$GAME_DIR" STOCK_DIR="$PUB/stock" bash "$HERE/load-cache.sh" --restore >/dev/null
if [[ -f "$PUB/current.zip" ]]; then
  GAME_DIR="$GAME_DIR" STOCK_DIR="$PUB/stock" bash "$HERE/load-cache.sh" "$PUB/current.zip"
  echo "reinstalled the last published cache"
fi
chown -R "$GAME_USER:$GAME_USER" "$GAME_DIR"

echo "== services"
for unit in rsc-game-data.service rsc-game.service rsc-game-publish.service rsc-game-publish.path; do
  install -m 0644 "$HERE/$unit" /etc/systemd/system/
done
# The editor runs with ProtectSystem=strict; the inbox is its one way out.
mkdir -p /etc/systemd/system/rsc-editor.service.d
cat > /etc/systemd/system/rsc-editor.service.d/publish.conf <<'CONF'
[Service]
ReadWritePaths=/var/lib/rsc-game/inbox
CONF
systemctl daemon-reload
systemctl enable rsc-game-data.service rsc-game.service rsc-game-publish.path
systemctl restart rsc-game-data.service rsc-game.service
systemctl start rsc-game-publish.path

echo "== caddy"
install -d /etc/caddy/sites
install -m 0644 "$HERE/rsc-game.caddy" /etc/caddy/sites/rsc-game.caddy
grep -q '^RSC_GAME_ADDRESS=' /etc/default/caddy 2>/dev/null || echo 'RSC_GAME_ADDRESS=:8081' >> /etc/default/caddy
# deploy/Caddyfile imports /etc/caddy/sites/*.caddy; an older copy does not.
install -m 0644 "$SRC_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl reload-or-restart caddy.service

echo "== editor"
set_env() {
  if grep -q "^$1=" "$EDITOR_ENV"; then
    sed -i "s|^$1=.*|$1=$2|" "$EDITOR_ENV"
  else
    printf '%s=%s\n' "$1" "$2" >> "$EDITOR_ENV"
  fi
}
set_env PUBLISH_DIR "$PUB"
set_env WORLDS_FILE "$ETC/worlds.json"
[[ -n "$GAME_URL" ]] && set_env GAME_URL "$GAME_URL"
systemctl restart rsc-editor.service

sleep 3
if ss -ltn | grep -q ':43595 '; then
  echo "game server is up"
else
  echo "game server is not listening yet -- see: journalctl -u rsc-game -n 50" >&2
fi

echo
echo "Done. Next:"
echo "  1. point your front proxy at this container's port 8081 for the game's domain"
echo "     (it must pass WebSockets; Caddy does by default)"
echo "  2. in the editor, open a project and press Publish"
