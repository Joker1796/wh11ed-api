#!/usr/bin/env bash
# GW update watch on our server: every 20 minutes, mails the owner when Games Workshop ships a new
# app version in the App Store, re-prices the MFM or posts a document on warhammer-community.com.
# Google Play is not reachable from here (blocked from Russia) and stays in wh11ed's GitHub workflow.
# The check itself is wh11ed's scripts/watch-gw.py; it moved here from GitHub Actions on 2026-10-14,
# because GitHub ran the hourly schedule hours late (the 2.8.0 app was mailed 4.5 hours after it
# shipped).
#
# Runs from cron as the deploy user (/etc/cron.d/wh-rules-gw-watch, log: `journalctl -t wh-gw-watch`).
# Lives in /opt/wh-rules/watch:
#   wh11ed/     a sparse, shallow clone of wh11ed (scripts/, src/data/mfm/, src/data/mfmFactions.js),
#               reset to origin/main on every run — the MFM diff is against what the site ships
#   state.json  what the watch saw last (the first run without it records a baseline, mails nothing)
#   failing     present while runs fail: the failure is mailed once, not every 20 minutes
# Mail goes through the API container's notice relay (scripts/notify.ts), the SMTP bug reports use.
set -uo pipefail
cd /opt/wh-rules
W=/opt/wh-rules/watch
R=$W/wh11ed
export WATCH_MAIL_CMD="docker compose -f /opt/wh-rules/docker-compose.prod.yml exec -T api node --import tsx scripts/notify.ts"

fail() {
  echo "gw-watch FAILED: $1"
  [ -f "$W/failing" ] && return
  { echo "Проверка обновлений GW на сервере сломалась ($(date '+%Y-%m-%d %H:%M %Z')): $1."; echo
    echo "Пока её не починить, писем об обновлениях не будет."; echo
    echo "Лог: journalctl -t wh-gw-watch · повтор вручную: /opt/wh-rules/gw-watch.sh"; } \
    | $WATCH_MAIL_CMD "[WH Rules] GW: проверка обновлений сломалась" && touch "$W/failing"
}

if ! { git -C "$R" fetch -q --depth 1 origin main && git -C "$R" reset -q --hard FETCH_HEAD; }; then
  fail "не удалось обновить копию wh11ed"; exit 1
fi
if python3 "$R/scripts/watch-gw.py" --state "$W/state.json" --sources appstore,mfm,warcom; then
  rm -f "$W/failing"
else
  fail "watch-gw.py завершился с ошибкой"; exit 1
fi
