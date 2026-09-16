#!/usr/bin/env bash
# Import a cache into the deployed editor, as the service user and with the
# server's database settings. Arguments go straight to the importer:
#
#   bash /opt/rsc-editor/deploy/import.sh --cache /srv/rsc-cache --project "Gielinor" \
#       --owner <your user id> --scenery /srv/rsc-cache/object-locs.json
#
# `bash deploy/import.sh --help` lists every option.
set -euo pipefail

APP_DIR=/opt/rsc-editor
ENV_FILE=/etc/rsc-editor/server.env
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

# Read, not sourced: the file is node --env-file syntax, where
# `DISCORD_SCOPES=identify email` is fine and bash would run `email`.
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | tail -1)"
args=$(printf '%q ' "$@")
su rsc -s /bin/bash -c "cd '$APP_DIR/tools/import-cache' && DATABASE_URL='$DATABASE_URL' node --import tsx src/cli.ts $args"
