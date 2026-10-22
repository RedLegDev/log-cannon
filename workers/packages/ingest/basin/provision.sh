#!/usr/bin/env bash
# Provision the Basin resources Log Cannon v2 writes to and reads from.
# One-off and idempotent enough to re-run: each step tolerates "already exists".
#
# Needs:
#   CLOUDFLARE_ACCOUNT_ID   the account to provision into
#   BASIN_CATALOG_TOKEN     API token with R2 Admin Read & Write (the sink and
#                           compaction write through it; Basin SQL reads with it)
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${BASIN_CATALOG_TOKEN:?set BASIN_CATALOG_TOKEN}"

BUCKET="${BASIN_BUCKET:-log-cannon-events}"
STREAM=log_events_v1
SINK=log_events_v1_catalog
PIPELINE=log_events_v1_pipeline
HERE="$(cd "$(dirname "$0")" && pwd)"
# The `basin` command family needs a newer wrangler than the workspace pins.
W="${WRANGLER:-npx --yes wrangler@4.152.0}"

step() { echo "==> $*"; }
tolerate() { "$@" 2>&1 | tee /dev/stderr | grep -qiE "already exists|already enabled" && return 0 || return "${PIPESTATUS[0]}"; }

step "bucket $BUCKET"
tolerate $W r2 bucket create "$BUCKET" || true

step "catalog on $BUCKET"
tolerate $W basin catalog enable "$BUCKET" || true

step "compaction + snapshot expiration"
$W basin catalog compaction enable "$BUCKET" --target-size 128 --token "$BASIN_CATALOG_TOKEN" || true
$W basin catalog snapshot-expiration enable "$BUCKET" --older-than-days 7 --retain-last 5 --token "$BASIN_CATALOG_TOKEN" || true

step "stream $STREAM"
tolerate $W basin pipelines streams create "$STREAM" --schema-file "$HERE/log_events_v1.schema.json" --http-enabled false || true

step "sink $SINK -> logs.events"
tolerate $W basin pipelines sinks create "$SINK" \
  --type r2-data-catalog --bucket "$BUCKET" \
  --namespace logs --table events \
  --roll-interval 60 --compression zstd \
  --catalog-token "$BASIN_CATALOG_TOKEN" || true

step "pipeline $PIPELINE"
tolerate $W basin pipelines create "$PIPELINE" --sql "INSERT INTO $SINK SELECT * FROM $STREAM" || true

step "done. Stream id for the Worker binding:"
$W basin pipelines streams list | grep -E "$STREAM|id" || true
