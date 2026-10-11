#!/usr/bin/env bash
# Nightly backup: pg_dump → encrypted with age → S3 at ANOTHER company than the server (the outage of
# 2026-10-11 took the database and its only copies down together; never again one basket).
#
# The server holds only the age PUBLIC key: it can encrypt, it cannot decrypt. The private key is on
# the owner's machine (~/.config/wh-rules/backup-age.key) — a leaked server or bucket reveals nothing.
# Restore: README "Deploy → Restore".
#
# Runs from cron as the deploy user (/etc/cron.d/wh-rules-backup). Config in /opt/wh-rules/backup.env:
#   S3_ENDPOINT  S3_BUCKET  AWS_ACCESS_KEY_ID  AWS_SECRET_ACCESS_KEY  AWS_DEFAULT_REGION
#   AGE_RECIPIENT   (the public key, age1…)
# Keeps 14 dailies and the first of each month for 12 months.
set -euo pipefail
cd /opt/wh-rules
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
[ "$day" = "01" ] && s3 s3 cp "/work/wh-$stamp.dump.age" "s3://$S3_BUCKET/monthly/wh-$stamp.dump.age" --only-show-errors

# Retention: names sort by time, so "all but the newest N" is a plain tail.
prune() {
  s3 s3 ls "s3://$S3_BUCKET/$1/" | awk '{print $4}' | sort | head -n "-$2" \
    | while read -r name; do [ -n "$name" ] && s3 s3 rm "s3://$S3_BUCKET/$1/$name" --only-show-errors; done
}
prune daily 14
prune monthly 12

echo "backup ok: wh-$stamp.dump.age ($size bytes)"
