#!/usr/bin/env bash
# First-time setup of RSC Editor on a Debian 12 LXC. Run as root, from a
# checkout of the repository:
#
#   bash deploy/install.sh
#
# Safe to run again: every step checks before it changes anything, and the
# secrets in /etc/rsc-editor/server.env are never regenerated.
set -euo pipefail

APP_DIR=/opt/rsc-editor
ENV_FILE=/etc/rsc-editor/server.env
NODE_MAJOR=24
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

echo "== packages"
apt-get update
apt-get install -y ca-certificates curl gnupg git rsync openssl postgresql debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

corepack enable

echo "== user and directories"
id rsc >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/rsc --shell /usr/sbin/nologin rsc
install -d -o rsc -g rsc "$APP_DIR"
install -d -m 0750 -o root -g rsc /etc/rsc-editor
install -d -m 0750 -o postgres -g postgres /var/backups/rsc-editor

echo "== database"
# Not every template starts services on install.
systemctl enable --now postgresql
if [[ ! -f "$ENV_FILE" ]]; then
  DB_PASSWORD="$(openssl rand -hex 24)"
  SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  su postgres -c "psql -v ON_ERROR_STOP=1" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rsc') THEN
    CREATE ROLE rsc LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE rsc PASSWORD '${DB_PASSWORD}';
  END IF;
END \$\$;
SQL
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname = 'rsc_editor'\"" | grep -q 1 \
    || su postgres -c "createdb -O rsc -E UTF8 rsc_editor"

  sed -e "s|^DATABASE_URL=.*|DATABASE_URL=postgres://rsc:${DB_PASSWORD}@127.0.0.1:5432/rsc_editor|" \
      -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|" \
      "$SRC_DIR/deploy/server.env.example" > "$ENV_FILE"
  chown root:rsc "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  echo "wrote $ENV_FILE -- fill in PUBLIC_URL, WEB_ORIGIN and the Discord values"
fi

echo "== caddy"
install -m 0644 "$SRC_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
grep -q '^RSC_SITE_ADDRESS=' /etc/default/caddy 2>/dev/null || echo 'RSC_SITE_ADDRESS=:80' >> /etc/default/caddy
mkdir -p /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/rsc-editor.conf <<'CONF'
[Service]
EnvironmentFile=-/etc/default/caddy
CONF

echo "== services"
install -m 0644 "$SRC_DIR/deploy/rsc-editor.service" /etc/systemd/system/
install -m 0644 "$SRC_DIR/deploy/rsc-editor-backup.service" /etc/systemd/system/
install -m 0644 "$SRC_DIR/deploy/rsc-editor-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable rsc-editor.service
# --now: an enabled timer does not run until the next boot otherwise.
systemctl enable --now rsc-editor-backup.timer caddy.service

"$SRC_DIR/deploy/update.sh"

echo
echo "Done. Next:"
echo "  1. edit $ENV_FILE (PUBLIC_URL, WEB_ORIGIN, DISCORD_*), then: systemctl restart rsc-editor"
echo "  2. set RSC_SITE_ADDRESS in /etc/default/caddy if this container terminates TLS, then: systemctl restart caddy"
echo "  3. import a cache: see deploy/README.md"
