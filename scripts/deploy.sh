#!/usr/bin/env bash
#
# Build the function bundle and ship it as a new version — with the yc CLI, not Terraform.
#
# WHY NOT TERRAFORM: this repo's state was a local file in a checkout that no longer exists, and
# nothing on any machine has it. `terraform apply` from an empty state does not "adopt" the eleven
# live resources — it tries to CREATE them, `yandex_ydb_database_serverless` (the database holding
# users' games and army lists) included. Until somebody imports the resources into a fresh state,
# infra/ is documentation, not a deploy path. See README.md.
#
# WHAT THIS DOES: takes the config of the version currently serving traffic and creates a new one
# just like it, with new code. Runtime, entrypoint, memory, timeout, service account, environment
# and Lockbox secret bindings are all carried over — so the thing you cannot see (a secret binding
# silently dropped) cannot be forgotten. Only what you deliberately override changes.
#
# CHANGING AN ENV VAR: put `KEY=value` lines in a gitignored `deploy.env`; they override the live
# values, everything else rides along unchanged. Deleting a var needs the yc call by hand.
#
# ADDING A SECRET: put `ENV_VAR=secretId:key` lines in a gitignored `deploy.secrets`. The live
# version's bindings are copied as they are (pinned to the version they were deployed with —
# that is deliberate: a deploy must not silently pick up a half-written secret), while a binding
# named here is resolved to the secret's CURRENT version, which is what you want for one you
# just created. A line for an env var the live version already binds replaces that binding.
#
# Prereqs: `yc` authenticated, and the folder holding the function selected.
#
# Usage:
#   bash scripts/deploy.sh              # build, show the plan, ship it
#   bash scripts/deploy.sh --dry-run    # build and show the plan, change nothing
set -euo pipefail
cd "$(dirname "$0")/.."

FUNCTION_ID="${FUNCTION_ID:-d4ep709m8kaluo5a6ga7}"
YC="${YC:-$HOME/yandex-cloud/bin/yc}"
DRY_RUN=""
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
[ -x "$YC" ] || { echo "yc not found at $YC (override with YC=/path/to/yc)" >&2; exit 1; }

echo "▶ Typecheck + bundle"
npm run build

echo "▶ Zipping dist → dist/function.zip"
rm -f dist/function.zip
( cd dist && zip -q -r function.zip handler.js package.json )

echo "▶ Reading the live version's config"
LIVE=$("$YC" serverless function version list --function-id "$FUNCTION_ID" --format json \
  | jq -r 'sort_by(.created_at) | last | .id')
[ -n "$LIVE" ] && [ "$LIVE" != "null" ] || { echo "no existing version to copy config from" >&2; exit 1; }
CFG=$("$YC" serverless function version get "$LIVE" --format json)
echo "  copying from $LIVE ($(echo "$CFG" | jq -r '.created_at'))"

# Overrides, if any. Blank lines and #comments ignored; the rest must be KEY=value.
declare -a OVERRIDE_KEYS=()
declare -a OVERRIDE_VALS=()
if [ -f deploy.env ]; then
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    OVERRIDE_KEYS+=("${line%%=*}")
    OVERRIDE_VALS+=("${line#*=}")
  done < deploy.env
  echo "  deploy.env overrides: ${OVERRIDE_KEYS[*]:-none}"
fi

# --- Build the argument list -------------------------------------------------------------------
# Note on `--environment`: yc splits a single occurrence on commas, so a value that CONTAINS a
# comma (ALLOWED_ORIGINS holds a list) must arrive in its own flag — one pair per occurrence,
# where the single `=` keeps the whole string intact.
declare -a ARGS=(
  --function-id "$FUNCTION_ID"
  --source-path dist/function.zip
  --runtime "$(echo "$CFG" | jq -r '.runtime')"
  --entrypoint "$(echo "$CFG" | jq -r '.entrypoint')"
  --memory "$(( $(echo "$CFG" | jq -r '.resources.memory') / 1024 / 1024 ))m"
  --execution-timeout "$(echo "$CFG" | jq -r '.execution_timeout')"
  --service-account-id "$(echo "$CFG" | jq -r '.service_account_id')"
)

echo "▶ Environment"
while IFS= read -r key; do
  value=$(echo "$CFG" | jq -r --arg k "$key" '.environment[$k]')
  mark=" "
  for i in "${!OVERRIDE_KEYS[@]}"; do
    if [ "${OVERRIDE_KEYS[$i]}" = "$key" ]; then value="${OVERRIDE_VALS[$i]}"; mark="*"; fi
  done
  echo "  $mark $key=$value"
  ARGS+=(--environment "$key=$value")
done < <(echo "$CFG" | jq -r '.environment // {} | keys[]')

# A key that exists only in deploy.env is a new variable, not an override.
for i in "${!OVERRIDE_KEYS[@]}"; do
  key="${OVERRIDE_KEYS[$i]}"
  if [ "$(echo "$CFG" | jq -r --arg k "$key" '.environment | has($k)')" != "true" ]; then
    echo "  + $key=${OVERRIDE_VALS[$i]}"
    ARGS+=(--environment "$key=${OVERRIDE_VALS[$i]}")
  fi
done

# Secret bindings travel as references — id, version, key. No secret VALUE passes through here.
# Ones declared in deploy.secrets are added (or replace a live binding of the same env var) and
# resolved to the secret's current version; the rest are copied verbatim.
declare -a EXTRA_ENV=()
declare -a EXTRA_ARGS=()
if [ -f deploy.secrets ]; then
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    env_var="${line%%=*}"
    ref="${line#*=}"
    secret_id="${ref%%:*}"
    secret_key="${ref#*:}"
    version_id="$("$YC" lockbox secret get "$secret_id" --format json | jq -r '.current_version.id')"
    if [ -z "$version_id" ] || [ "$version_id" = "null" ]; then
      echo "✗ deploy.secrets: cannot resolve the current version of $secret_id" >&2
      exit 1
    fi
    EXTRA_ENV+=("$env_var")
    EXTRA_ARGS+=(--secret "id=$secret_id,version-id=$version_id,key=$secret_key,environment-variable=$env_var")
  done < deploy.secrets
fi

echo "▶ Lockbox bindings"
while IFS= read -r secret; do
  env_var="$(echo "$secret" | jq -r '.environment_variable')"
  skip=""
  for e in ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}; do [ "$e" = "$env_var" ] && skip=1; done
  if [ -n "$skip" ]; then
    echo "  $env_var ← replaced by deploy.secrets"
    continue
  fi
  echo "  $env_var ← $(echo "$secret" | jq -r '.id'):$(echo "$secret" | jq -r '.key')"
  ARGS+=(--secret "id=$(echo "$secret" | jq -r '.id'),version-id=$(echo "$secret" | jq -r '.version_id'),key=$(echo "$secret" | jq -r '.key'),environment-variable=$env_var")
done < <(echo "$CFG" | jq -c '.secrets // [] | .[]')
for i in ${!EXTRA_ENV[@]+"${!EXTRA_ENV[@]}"}; do
  echo "  ${EXTRA_ENV[$i]} ← deploy.secrets (current version)"
done
ARGS+=(${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"})

if [ -n "$DRY_RUN" ]; then
  echo "▶ --dry-run: nothing was deployed."
  exit 0
fi

echo "▶ Creating the version"
"$YC" serverless function version create "${ARGS[@]}" | grep -E '^id:|^status:|^created_at:'

echo "✔ Done. Smoke-test before believing it: GET /health, then a round trip on what changed."
