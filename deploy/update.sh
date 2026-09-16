#!/usr/bin/env bash
# Deploy the checkout this script lives in to /opt/rsc-editor: copy, install,
# build, migrate, restart. Run as root after `git pull`:
#
#   bash deploy/update.sh
#
# The database is migrated before the new server starts, and a failed build or
# migration leaves the running server alone.
set -euo pipefail

APP_DIR=/opt/rsc-editor
ENV_FILE=/etc/rsc-editor/server.env
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "$ENV_FILE is missing; run deploy/install.sh first" >&2; exit 1; }

as_rsc() { su rsc -s /bin/bash -c "cd '$APP_DIR' && $*"; }

echo "== copy"
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  # fixtures/ is test data (Jagex assets), never shipped; .env files are local.
  rsync -a --delete \
    --exclude .git --exclude node_modules --exclude .turbo --exclude 'fixtures/' \
    --exclude '.env' --exclude '.env.*' --exclude 'dist/' --exclude 'test-results/' \
    "$SRC_DIR/" "$APP_DIR/"
  chown -R rsc:rsc "$APP_DIR"
fi

echo "== install"
as_rsc "COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile"

echo "== typecheck and build"
as_rsc "pnpm typecheck"
# VITE_API_MODE=live: without it the build talks to the in-browser mock.
# No VITE_API_BASE: the app and the API share Caddy's origin.
as_rsc "cd apps/web && VITE_API_MODE=live pnpm exec vite build"

echo "== migrate"
# Read, not sourced: the file is node --env-file syntax, where
# `DISCORD_SCOPES=identify email` is fine and bash would run `email`.
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | tail -1)"
as_rsc "cd packages/db && DATABASE_URL='$DATABASE_URL' pnpm exec drizzle-kit migrate"

echo "== restart"
if ! grep -qE '^DISCORD_CLIENT_ID=.+' "$ENV_FILE" || ! grep -qE '^DISCORD_CLIENT_SECRET=.+' "$ENV_FILE"; then
  # The server refuses to boot without them (src/config.ts); say so plainly
  # instead of failing a health check on a first install.
  echo "not starting the server: fill in DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in $ENV_FILE"
  systemctl stop rsc-editor.service || true
  systemctl reload-or-restart caddy.service
  exit 0
fi
systemctl restart rsc-editor.service
systemctl reload-or-restart caddy.service
sleep 2
if curl -fsS http://127.0.0.1:8080/api/health >/dev/null; then
  echo "server is up"
else
  echo "server did not answer /api/health -- see: journalctl -u rsc-editor -n 50" >&2
  exit 1
fi
