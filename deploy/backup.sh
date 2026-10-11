#!/usr/bin/env bash
# Nightly backup: pg_dump → encrypted with age → S3 at ANOTHER company than the server (the outage of
# 2026-10-11 took the database and its only copies down together; never again one basket).
#
# The server holds only the age PUBLIC key: it can encrypt, it cannot decrypt. The private key is on
# the owner's machine (~/.config/wh-rules/backup-age.key) — a leaked server or bucket reveals nothing.
# Restore: README "Deploy → Restore".
#
# Runs from cron as the deploy user at 03:30 Moscow time (/etc/cron.d/wh-rules-backup, log:
# `journalctl -t wh-backup`). Config in /opt/wh-rules/backup.env (chmod 600):
#   S3_ENDPOINT  S3_BUCKET  AWS_ACCESS_KEY_ID  AWS_SECRET_ACCESS_KEY  AWS_DEFAULT_REGION
#   AGE_RECIPIENT   (the public key, age1…)
# Production: Timeweb S3 (https://s3.twcstorage.ru, region ru-1), bucket wh-rules-backups, cold class,
# private, written by a bucket-only user with read+write — never the account's admin keys.
# Keeps 14 dailies and the first of each month for 12 months.
set -Eeuo pipefail   # -E: the ERR trap below must also fire inside functions (s3, prune)
cd /opt/wh-rules

# A failure is mailed to the owner (the same relay bug reports use, through the API container) with
# the run's last lines. Without this a broken backup is silent: the uptime checks only see HTTP.
LOG=/opt/wh-rules/backup.last.log
exec > >(tee "$LOG") 2>&1
on_error() {
  local line=$1
  echo "backup FAILED at line $line"
  sleep 1
  { echo "Ночной бэкап базы WH Rules не удался ($(date '+%Y-%m-%d %H:%M %Z'), строка $line скрипта)."; echo
    echo "Последние строки:"; tail -n 25 "$LOG"; echo
    echo "Лог: journalctl -t wh-backup · повтор вручную: /opt/wh-rules/backup.sh"; } \
    | docker compose -f docker-compose.prod.yml exec -T api node --import tsx scripts/notify.ts \
        "wh-rules: ночной бэкап НЕ удался" || true
}
trap 'on_error $LINENO' ERR

set -a; . ./backup.env; set +a

stamp=$(date -u +%Y-%m-%dT%H%MZ)
day=$(date -u +%d)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U wh -d wh -Fc \
  | age -r "$AGE_RECIPIENT" > "$tmp/wh-$stamp.dump.age"
size=$(stat -c %s "$tmp/wh-$stamp.dump.age")
[ "$size" -gt 1000 ] || { echo "backup suspiciously small ($size bytes) — not uploading" >&2; exit 1; }

s3() { docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
  -v "$tmp:/work" amazon/aws-cli:2.27.0 --endpoint-url "$S3_ENDPOINT" "$@"; }

s3 s3 cp "/work/wh-$stamp.dump.age" "s3://$S3_BUCKET/daily/wh-$stamp.dump.age" --only-show-errors
if [ "$day" = "01" ]; then s3 s3 cp "/work/wh-$stamp.dump.age" "s3://$S3_BUCKET/monthly/wh-$stamp.dump.age" --only-show-errors; fi

# Retention: names sort by time, so "all but the newest N" is a plain tail.
# `aws s3 ls` exits 1 on a prefix that holds nothing yet (monthly/ until the first of a month) —
# an empty listing, not a failure.
prune() {
  { s3 s3 ls "s3://$S3_BUCKET/$1/" || true; } | awk '{print $4}' | sort | head -n "-$2" \
    | while read -r name; do [ -n "$name" ] && s3 s3 rm "s3://$S3_BUCKET/$1/$name" --only-show-errors; done
}
prune daily 14
prune monthly 12

echo "backup ok: wh-$stamp.dump.age ($size bytes)"
