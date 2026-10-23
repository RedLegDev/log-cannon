#!/usr/bin/env python3
"""Compare per-source, per-hour row counts between ClickHouse (v1) and Basin (v2).

Dual-write check for #163. Buckets on event time, over complete hours that
ended at least --settle hours ago, so late flushes on either side don't read
as gaps.

Expected differences, which are not bugs:
  * ClickHouse runs a little high. Queue redeliveries insert duplicate rows
    there, and the Basin sink writes exactly once.
  * Sources that skip the Worker's request path exist only in ClickHouse:
    the Worker's own telemetry (SLOW_REQUEST_SOURCE), supabase-pull rows
    and MCP create_log. Pass them with --exclude.

Env:
  LOG_CANNON_URL       default https://logs.redleg.dev
  LOG_CANNON_API_KEY   key with query scope (v1 /api/v1/query)
  BASIN_SQL_TOKEN      token with Basin SQL read
  CLOUDFLARE_ACCOUNT_ID, BASIN_BUCKET (default log-cannon-events)

Usage: reconcile.py [--hours 6] [--settle 1] [--exclude log-cannon-ingest ...]
Exit 1 if any source/hour is missing more than --tolerance of its ClickHouse rows.
"""

import argparse
import datetime as dt
import json
import os
import sys
import urllib.request


def post(url, headers, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def clickhouse(sql):
    base = os.environ.get("LOG_CANNON_URL", "https://logs.redleg.dev").rstrip("/")
    out = post(
        f"{base}/api/v1/query",
        # Cloudflare 403s the default python-urllib User-Agent on redleg.dev.
        {"X-Api-Key": os.environ["LOG_CANNON_API_KEY"], "Content-Type": "application/json",
         "User-Agent": "log-cannon-reconcile/1.0"},
        {"sql": sql},
    )
    return out.get("data", out.get("rows", out))


def basin(sql):
    acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    bucket = os.environ.get("BASIN_BUCKET", "log-cannon-events")
    out = post(
        f"https://api.sql.cloudflarestorage.com/api/v1/accounts/{acct}/basin-sql/query/{bucket}",
        {"Authorization": f"Bearer {os.environ['BASIN_SQL_TOKEN']}", "Content-Type": "application/json"},
        {"query": sql},
    )
    if not out.get("success"):
        raise SystemExit(f"Basin SQL failed: {out.get('errors')}")
    return out["result"]["rows"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=6)
    ap.add_argument("--settle", type=int, default=1)
    ap.add_argument("--exclude", nargs="*", default=["log-cannon-ingest"])
    ap.add_argument("--tolerance", type=float, default=0.001)
    a = ap.parse_args()

    now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    end = now - dt.timedelta(hours=a.settle)
    start = end - dt.timedelta(hours=a.hours)
    ex = ",".join("'" + s.replace("'", "''") + "'" for s in a.exclude) or "''"

    ch_rows = clickhouse(
        "SELECT source, formatDateTime(toStartOfHour(timestamp), '%Y-%m-%dT%H:00:00Z') AS h, count() AS n "
        "FROM logs.events "
        f"WHERE timestamp >= toDateTime64('{start:%Y-%m-%d %H:%M:%S}', 3, 'UTC') "
        f"AND timestamp < toDateTime64('{end:%Y-%m-%d %H:%M:%S}', 3, 'UTC') "
        f"AND source NOT IN ({ex}) GROUP BY source, h LIMIT 10000"
    )
    bs_rows = basin(
        "SELECT source, date_trunc('hour', ts) AS h, count(*) AS n FROM logs.events "
        f"WHERE ts >= '{start:%Y-%m-%dT%H:%M:%SZ}' AND ts < '{end:%Y-%m-%dT%H:%M:%SZ}' "
        f"AND source NOT IN ({ex}) GROUP BY source, date_trunc('hour', ts) LIMIT 10000"
    )

    def key(r):
        h = str(r["h"]).replace(" ", "T")[:13]
        return (r["source"], h)

    ch = {key(r): int(r["n"]) for r in ch_rows}
    bs = {key(r): int(r["n"]) for r in bs_rows}

    bad = 0
    tot_ch = sum(ch.values())
    tot_bs = sum(bs.values())
    print(f"window {start:%Y-%m-%dT%H}Z → {end:%Y-%m-%dT%H}Z  clickhouse={tot_ch}  basin={tot_bs}")
    for k in sorted(set(ch) | set(bs)):
        c, b = ch.get(k, 0), bs.get(k, 0)
        missing = c - b
        flag = ""
        if missing > max(1, c * a.tolerance):
            flag = "  << MISSING IN BASIN"
            bad += 1
        elif b > c:
            flag = "  >> basin higher"
        if flag or c != b:
            print(f"{k[0]:<40} {k[1]}  ch={c:<8} basin={b:<8} diff={b - c:+d}{flag}")
    print(f"{bad} source-hours short beyond tolerance")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
