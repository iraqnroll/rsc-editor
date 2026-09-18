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
| `ADMIN_DISCORD_USERNAMES` | **your** Discord username (comma separated for several). Everyone else needs an invite, so without this nobody can get in. |
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

Copy a cache directory (the `*.jag` / `*.mem` files) into the container and
import it:

```sh
bash /opt/rsc-editor/deploy/import.sh \
  --cache /srv/rsc-cache --project "Gielinor" \
  --scenery /root/rsc-editor/fixtures/scenery/object-locs.json
```

`--scenery` is optional (the placement list is not part of the cache; see
`docs/DECISIONS.md` §12). So is `--spawns <dir>`, which places the game
server's NPCs, ground items and doors from an rsc-data `locations/` directory
(§19); with it, an export also carries `npcs.json`, `items.json` and
`wall-objects.json`. `bash deploy/import.sh --help` lists the rest.
Admins see every project, so no `--owner` is needed.

## 5. Let people in

Sign in with Discord as the admin, then open **Access** (top bar, or under the
project list):

- **Add** someone by Discord username. Only people on the list can sign in;
  anyone else is sent back with "not on this editor's access list".
- Pick their role in each project: viewer, editor or owner. It applies as soon
  as they sign in for the first time, and keeps working if they later change
  their Discord username.
- **Revoke** signs them out everywhere at once and stops them signing in;
  **restore** undoes it. Changing someone's project role drops their open
  connection so the new role applies immediately.
- Tick **Admin** to make someone an admin: they can open every project and
  manage this list.

`DISCORD_GUILD_ID` still works on top of this if you also want to require
membership of your Discord server.

## 6. The game server (optional)

Runs the game — rsc-server, its data server and the rsc-client web client,
kept together in [iraqnroll/rsc-game](https://github.com/iraqnroll/rsc-game) —
in the same container, and turns on the editor's **Publish** button.

```sh
cd /root/rsc-editor && bash deploy/game/install.sh --game-url https://game.example.com
```

**Deploying game code** is the same command again: it fetches the branch it
follows (`main`), reinstalls, rebuilds the client, puts the last published
cache back and restarts. `--repo <url>` and `--ref <branch|commit>` choose
something else and are remembered in `/etc/rsc-game/source`.

Then point your front proxy at this container's port **8081** for the game's
domain (it must pass WebSockets; Caddy does by default). Over https the
client's socket goes to `wss://<game domain>/ws`, which the container's Caddy
hands to rsc-server. `RSC_GAME_ADDRESS` in `/etc/default/caddy` works like
`RSC_SITE_ADDRESS`.

**Publish** (admins only, top bar) builds exactly what Export would, and the
game restarts with it — everyone playing is disconnected. How it gets there:

1. the editor writes `/var/lib/rsc-game/inbox/cache.zip`, then `request.json`;
2. `rsc-game-publish.path` sees the request and starts
   `rsc-game-publish.service`, which runs `deploy/game/publish.sh` as root;
3. that installs the cache with `deploy/game/load-cache.sh`, restarts
   `rsc-game`, waits for it to listen, and writes
   `/var/lib/rsc-game/status.json`, which the button shows.

The editor itself only ever writes to the inbox. If the game does not come
back up with the new cache, the previous one is put back and the button
reports the failure.

**Worlds** (admins, top bar) shows each world: up or down, players online,
uptime and memory, and who is on (rank, level, position, address, time
online). From there you can broadcast a message, kick a player (saved first),
and restart with an in-game countdown — the world saves everyone at zero and
systemd starts it again. The editor reaches each world through its control
socket (`/run/rsc-game/world-1.sock`, listed in `/etc/rsc-game/worlds.json`);
the editor's user is in the `rscgame` group, which is all that socket allows.

A publish now warns players too: with anyone online, they get a 30-second
countdown (`PUBLISH_COUNTDOWN` in `rsc-game-publish.service`), then the
restart logs everyone out, which saves them. Any `systemctl stop` or
`restart` of the game saves players the same way.

Players' real addresses reach the game (`X-Real-IP`, trusted only from this
container's Caddy), so the data server's one-login-per-address rule counts
people, not the proxy. The main Caddyfile trusts private-range proxies to
say who the client is; narrow `trusted_proxies` to your front proxy if the
LAN is not yours. Raise `playersPerIP` in `/etc/rsc-game/data-server.json`
if several people share one address.

**Events** (a tab in Worlds) is what happened in the game: logins and
logouts with addresses, chat, private messages, drops, pickups (with whose
item it was), deaths, `::` commands tried, and admin actions. Search by
player — clicking a name gives that player's timeline, as either party — by
type, text and date. Each world writes events to
`/var/lib/rsc-game-events/world-1.jsonl` first and forgets them only once the
editor has stored them, so an editor restart loses nothing. They are kept for
`GAME_EVENT_RETENTION` (chat and PMs 90 days, drops and pickups 30, the rest
a year, by default), then deleted. Trades are not logged: trading is a stub
in rsc-server (`model/trade.js`) and never completes.

**Admin log** (the other tab) is every admin action outside the map — world
actions, publishes, Access changes — with who, what, whom, and whether it
worked, including attempts by people who were not allowed. It is
append-only in the database itself and kept for good.

Staff ranks are set with the data server's script while the player is
logged out:

```sh
cd /opt/rsc-game/rsc-data-server && sudo -u rscgame node src/set-rank.js <username> 3 /etc/rsc-game/data-server.json
```

In game, `::help` lists what your rank can use.

Tested in a systemd Debian 12 container: the install, a publish from the
editor's button through to the game listening on the new cache, a corrupt
cache rolled back with the game left running, and the WebSocket handshake
through `/ws`. A player logging in over https has not been tried.

Accounts are in `/var/lib/rsc-game-accounts` and survive a reinstall. The last
published cache is kept as `/var/lib/rsc-game/current.zip` and reinstalled by
every deploy. `load-cache.sh --restore` (with `GAME_DIR=/opt/rsc-game
STOCK_DIR=/var/lib/rsc-game/stock`) returns the game to the cache the
repository ships.

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
| game log | `journalctl -u rsc-game -f`, `journalctl -u rsc-game-data -f` |
| last publish | `journalctl -u rsc-game-publish`, `/var/lib/rsc-game/status.json`, `/var/lib/rsc-game/work/log` |
| game config | `/etc/rsc-game/server.json`, `/etc/rsc-game/data-server.json`, `/etc/rsc-game/worlds.json` |
