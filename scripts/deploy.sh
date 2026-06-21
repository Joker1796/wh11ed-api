#!/usr/bin/env bash
#
# Build the function bundle and apply infrastructure with Terraform.
#
# Prereqs:
#   - `yc` CLI authenticated (or YC_TOKEN set) and a folder selected
#   - secrets provided via infra/secret.auto.tfvars (gitignored) or TF_VAR_* env vars
#   - first run: after apply, create the CNAMEs printed in the outputs, wait for the cert to
#     become Issued, then run `npm run migrate` against the new YDB to create tables.
#
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Typecheck + bundle"
npm run build

echo "▶ Zipping dist → dist/function.zip"
( cd dist && zip -q -r function.zip handler.js package.json )

echo "▶ Terraform"
cd infra
terraform init -input=false
terraform apply -input=false "$@"

echo "✔ Done. Review outputs above for the gateway domain + cert validation CNAMEs."
