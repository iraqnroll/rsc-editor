# Deploying to a Proxmox LXC

One container runs everything: Postgres, the API server (systemd) and Caddy,
which serves the built editor and passes `/api` and `/ws` to the server. One
origin for all three is what lets the session cookie work without CORS.

Tested end to end on a Debian 12 container with systemd: install, re-install,
update, cache import, backup, and the Discord sign-in redirect. The Discord
**callback** itself has not been exercised against a real Discord app.

## 1. Create the container

- Template: **Debian 12**. Unprivileged is fine.
- Options → Features: **nesting=1** (Debian 12's systemd expects it).
- 2 cores, 4 GB RAM (the build and `pnpm install` want it; the server needs far
  less), 16 GB disk.
- A static IP, or a DHCP reservation, if another proxy will point at it.

## 2. Install

```sh
apt-get update && apt-get install -y git
git clone <this repository> /root/rsc-editor
bash /root/rsc-editor/deploy/install.sh
```

This installs Node 24, pnpm (corepack), Postgres and Caddy, creates the `rsc`
user and database with a random password, writes
`/etc/rsc-editor/server.env` with a random session secret, builds, migrates,
and enables the services and the nightly backup. Running it again changes
nothing it already set up. The server will not start until step 3 is done.

## 3. Configure

### Discord

At <https://discord.com/developers/applications>: create an application,
then under OAuth2 add the redirect

```
https://<your domain>/api/auth/discord/callback
```

and copy the client id and secret.

### `/etc/rsc-editor/server.env`

| key | value |
|---|---|
| `PUBLIC_URL` | `https://<your domain>` |
| `WEB_ORIGIN` | `https://<your domain>` (the same) |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | from Discord |
| `DISCORD_GUILD_ID` | optional: only members of that server can sign in (add `guilds` to `DISCORD_SCOPES`) |

Leave `HOST=127.0.0.1`: the server trusts `X-Forwarded-*`, so only Caddy may
reach it. `COOKIE_SECURE=true` is required, which means the editor must be
reached over **https**. Then `systemctl restart rsc-editor`.

### TLS

Pick one, in `/etc/default/caddy`, then `systemctl restart caddy`:

- **This container faces the internet** on 80/443:
  `RSC_SITE_ADDRESS=editor.example.com`. Caddy obtains and renews the
  certificate.
- **Another proxy terminates TLS** (Nginx Proxy Manager, Traefik, …): keep
  `RSC_SITE_ADDRESS=:80` and point the proxy at `http://<container ip>:80`.
  It must forward WebSockets and the `X-Forwarded-Proto`/`Host` headers.

## 4. Import a cache

Sign in with Discord once, so your account exists, then find its id:

```sh
su postgres -c "psql rsc_editor -c 'select id, username from users'"
```

Copy a cache directory (the `*.jag` / `*.mem` files) into the container, and
import it as your project:

```sh
bash /opt/rsc-editor/deploy/import.sh \
  --cache /srv/rsc-cache --project "Gielinor" --owner <your id> \
  --scenery /root/rsc-editor/fixtures/scenery/object-locs.json
```

`--scenery` is optional (the placement list is not part of the cache; see
`docs/DECISIONS.md` §12). `bash deploy/import.sh --help` lists the rest.
Other people join a project through its members list.

## Updating

```sh
cd /root/rsc-editor && git pull && bash deploy/update.sh
```

It copies the checkout to `/opt/rsc-editor`, installs, typechecks, builds,
migrates, restarts, and checks `/api/health`. A failed build or migration
stops before the restart, so the running server is left alone.

## Backups

`rsc-editor-backup.timer` dumps the database to `/var/backups/rsc-editor`
every night at about 03:30 and keeps 14 days. Copy that directory off the
container (or back up the container itself from Proxmox) — a backup on the
same disk is not a backup.

Restore into an empty database:

```sh
systemctl stop rsc-editor
su postgres -c "dropdb rsc_editor && createdb -O rsc rsc_editor"
su postgres -c "pg_restore -d rsc_editor /var/backups/rsc-editor/<file>.dump"
systemctl start rsc-editor
```

## Where to look

| what | where |
|---|---|
| server log | `journalctl -u rsc-editor -f` |
| proxy log | `journalctl -u caddy -f` |
| config | `/etc/rsc-editor/server.env`, `/etc/default/caddy` |
| code and build | `/opt/rsc-editor` (replaced by every update) |
| backups | `/var/backups/rsc-editor` |
