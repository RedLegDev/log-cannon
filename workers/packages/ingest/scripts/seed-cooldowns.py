#!/usr/bin/env python3
"""Seed v2 alert cooldowns from v1 before ALERTS_MODE goes live (refs #170).

v1's alert-worker keeps each alert's last send in its own store. Without this,
every alert still inside its v1 cooldown at go-live fires again from the
Worker. Reads `last_triggered_at` per alert from the v1 API and writes it into
D1 `alerts` for the same id, but only where it moves the value forward: a D1
time at or after v1's is left alone, so a rerun changes nothing and nothing
ever moves backwards. `shadow_last_triggered_at` is never touched.

Dry run by default: prints one line per alert (id, v1 time, D1 time, action)
and the counts. Pass --apply to write, then it re-reads D1 and reports.

v1 keeps sending until alert-worker stops, so run --apply again right after
it does: a send in between is otherwise not copied, and a rerun is a no-op
for everything already seeded.

Env:
  LOG_CANNON_URL         default https://logs.redleg.dev (v1 /api/v1/alerts)
  LOG_CANNON_API_KEY     v1 key with read scope
  CLOUDFLARE_API_TOKEN   token with D1 edit (D1 read for a dry run)
  CLOUDFLARE_ACCOUNT_ID
  D1_DATABASE_ID         the Worker's KEYS_DB (or --database-id)

Usage: seed-cooldowns.py [--apply] [--database-id ID]
"""

import argparse
import datetime as dt
import json
import os
import sys
import urllib.request

UA = "log-cannon-seed-cooldowns/1.0"


def env(name: str, default: str | None = None) -> str:
    v = os.environ.get(name, default)
    if not v:
        sys.exit(f"{name} is not set")
    return v


def fetch_json(url: str, headers: dict, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        url,
        data=None if body is None else json.dumps(body).encode(),
        headers={"User-Agent": UA, "Content-Type": "application/json", **headers},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def iso(t: dt.datetime) -> str:
    """The Worker's format (JS toISOString), so D1 strings compare in time order."""
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def parse_time(s: str | None) -> dt.datetime | None:
    """v1 sends ClickHouse's 'YYYY-MM-DD HH:MM:SS' (UTC); 1970-01-01 means never."""
    if not s:
        return None
    t = dt.datetime.fromisoformat(s.replace("Z", "+00:00").replace(" ", "T"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return None if t.year <= 1970 else t


class D1:
    def __init__(self, account: str, database: str, token: str):
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query"
        self.headers = {"Authorization": f"Bearer {token}"}

    def query(self, sql: str, params: list | None = None) -> list[dict]:
        r = fetch_json(self.url, self.headers, {"sql": sql, "params": params or []})
        if not r.get("success"):
            raise RuntimeError(f"D1 query failed: {r.get('errors')}")
        return r["result"][0]["results"]


def plan(v1: dict[str, dt.datetime | None], d1: dict[str, str | None]) -> list[tuple[str, str, str, str]]:
    rows = []
    for aid in sorted(set(v1) | set(d1)):
        v1_t = v1.get(aid)
        d1_t = parse_time(d1.get(aid))
        if aid not in d1:
            action = "not in D1" if v1_t else "skip: not in D1, never sent"
        elif aid not in v1:
            action = "keep: not in v1"
        elif not v1_t:
            action = "keep: never sent in v1"
        elif d1_t and d1_t >= v1_t:
            action = "keep: D1 is not older"
        else:
            action = "set"
        rows.append((aid, iso(v1_t) if v1_t else "-", d1.get(aid) or "-", action))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="write the plan into D1 (default: dry run)")
    ap.add_argument("--database-id", default=os.environ.get("D1_DATABASE_ID"))
    args = ap.parse_args()
    if not args.database_id:
        sys.exit("D1_DATABASE_ID is not set (or pass --database-id)")

    base = env("LOG_CANNON_URL", "https://logs.redleg.dev").rstrip("/")
    alerts = fetch_json(f"{base}/api/v1/alerts", {"X-Api-Key": env("LOG_CANNON_API_KEY")})["data"]
    v1 = {a["id"]: parse_time(a.get("last_triggered_at")) for a in alerts}
    d1 = D1(env("CLOUDFLARE_ACCOUNT_ID"), args.database_id, env("CLOUDFLARE_API_TOKEN"))
    current = {r["id"]: r["last_triggered_at"] for r in d1.query("SELECT id, last_triggered_at FROM alerts")}

    rows = plan(v1, current)
    print(f"{'id':36}  {'v1 last_triggered_at':24}  {'D1 last_triggered_at':24}  action")
    for aid, v1_s, d1_s, action in rows:
        print(f"{aid:36}  {v1_s:24}  {d1_s:24}  {action}")
    counts: dict[str, int] = {}
    for *_, action in rows:
        counts[action] = counts.get(action, 0) + 1
    print(f"\nv1 alerts {len(v1)}, with a trigger time {sum(1 for t in v1.values() if t)}; D1 alerts {len(current)}")
    print("; ".join(f"{k}: {n}" for k, n in sorted(counts.items())))

    todo = [(aid, v1_s) for aid, v1_s, _, action in rows if action == "set"]
    if not args.apply:
        print(f"\ndry run: {len(todo)} to set. Rerun with --apply to write.")
        return 0

    for aid, v1_s in todo:
        # The guard repeats the plan's check in SQL, so a value that moved on
        # since the read (a live send) is never pulled back.
        d1.query(
            "UPDATE alerts SET last_triggered_at = ?1 WHERE id = ?2 AND (last_triggered_at IS NULL OR last_triggered_at < ?1)",
            [v1_s, aid],
        )
    after = {r["id"]: r["last_triggered_at"] for r in d1.query("SELECT id, last_triggered_at FROM alerts")}
    behind = [aid for aid, v1_s in todo if (after.get(aid) or "") < v1_s]
    print(f"\napplied: {len(todo) - len(behind)} of {len(todo)} at or past v1")
    for aid in behind:
        print(f"NOT SET {aid}: D1 {after.get(aid)}")
    return 1 if behind else 0


if __name__ == "__main__":
    sys.exit(main())
