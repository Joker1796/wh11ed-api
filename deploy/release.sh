#!/usr/bin/env bash
# Ship the API: a committed ref of this repo (default `main`) to the server, rebuilt and restarted.
#
#   bash deploy/release.sh            # main
#   bash deploy/release.sh <ref>      # a branch or a commit
#   bash deploy/release.sh --rollback # put app.prev back
#
# The code goes as `git archive` of the ref — never the working tree — into /opt/wh-rules/app; the
# previous one is kept as app.prev for the rollback. Migrations run when the API container starts
# (`npm run migrate` in the compose entrypoint), so a schema change ships with the code that needs
# it (README "Changing the schema": schema, then API, then client). Run by the owner: the agent is
# not allowed to deploy (`! bash wh11ed-api/deploy/release.sh` from the hub).
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${WH_HOST:-wh@31.129.57.24}
SSH=(ssh -i "${WH_KEY:-$HOME/.ssh/wh_rules_vps}" "$HOST")
API=${WH_API:-https://api.wh-rules.ru}
COMPOSE='docker compose -f docker-compose.prod.yml'

check() {
  # /health does not touch the database; a broadcast that does not exist does — 404 not_found means
  # Postgres answered (wh11ed's reference: prod health probe).
  sleep 5
  curl -fsS "$API/health" >/dev/null && echo "  /health ok" || { echo "  ✗ /health failed"; return 1; }
  code=$(curl -s -o /dev/null -w '%{http_code}' "$API/broadcast/release-check-0000")
  [ "$code" = 404 ] && echo "  database ok (404 on a missing broadcast)" || { echo "  ✗ database check answered $code"; return 1; }
}

if [ "${1:-}" = "--rollback" ]; then
  echo "== rollback to app.prev"
  "${SSH[@]}" "set -e; cd /opt/wh-rules; [ -d app.prev ]; rm -rf app.bad; mv app app.bad; mv app.prev app; $COMPOSE up -d --build api"
  check
  exit
fi

REF=${1:-main}
[ -z "$(git status --porcelain)" ] || { echo "uncommitted changes — commit (or stash) first"; exit 1; }
SHA=$(git rev-parse --short "$REF")
echo "== shipping $REF ($SHA) to $HOST"
git archive --format=tar "$REF" | "${SSH[@]}" "set -e; cd /opt/wh-rules; rm -rf app.next; mkdir app.next; tar -x -C app.next; echo $SHA > app.next/REVISION; rm -rf app.prev; mv app app.prev; mv app.next app"
"${SSH[@]}" "cd /opt/wh-rules && $COMPOSE up -d --build api"
check
echo "== $SHA is live (rollback: bash deploy/release.sh --rollback)"
