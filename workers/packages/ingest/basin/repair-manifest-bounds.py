"""Repair bad manifest bounds (refs #187): Basin's writers can record a string column's
upper bound from one row group instead of the whole file (check-manifest-bounds.py finds
them), and Basin SQL then prunes real rows; an `exception` bound of ''/'' makes it read the
column as '' for every row. This swaps the named data files' manifest entries for entries
rebuilt from their own Parquet footers, in one overwrite snapshot. Same files, same rows.
Dry run by default. The rebuilt entries are correct by construction, so there is rarely
anything to undo; rolling the table back to the snapshot it prints first is the undo only
while nothing has been appended since (Pipelines appends every minute, and a rollback
drops those appends from the table).

  LOG_CANNON_BASIN_TOKEN=... (R2 Admin R&W)
  uv run --no-project --with "pyiceberg[pyarrow]" python -I repair-manifest-bounds.py \
      compacted-00000-....parquet [...] [--apply] [--skip-missing]

--skip-missing leaves out named files that are no longer live (compaction replaced them
since they were checked) instead of aborting. The footers are read first and the table is
reloaded just before the commit, because Pipelines appends about once a minute and an
overwrite fails validation if an append lands between its load and its commit; a lost race
is retried 4 times. Exit 3 means every attempt lost; nothing was changed.

First used 2026-11-04 on the 10-26 and 11-03 files (vault: 2026-11-04 compaction bound repair).
"""

import os
import sys

from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.exceptions import CommitFailedException, ValidationException
from pyiceberg.io.pyarrow import parquet_file_to_data_file

ACCOUNT = "ab1da25c524f59bc61f776304bd88558"
TARGETS = [a for a in sys.argv[1:] if not a.startswith("--")]

apply = "--apply" in sys.argv
if not TARGETS:
    sys.exit(__doc__)
cat = RestCatalog(
    "basin",
    uri=f"https://catalog.cloudflarestorage.com/{ACCOUNT}/log-cannon-events",
    warehouse=f"{ACCOUNT}_log-cannon-events",
    token=os.environ["LOG_CANNON_BASIN_TOKEN"],
)
table = cat.load_table("logs.events")
snap = table.current_snapshot()
print("current snapshot", snap.snapshot_id, "parent", snap.parent_snapshot_id)

live = {t.file.file_path.rsplit("/", 1)[-1]: t.file for t in table.scan().plan_files()}
pairs = []
for name in TARGETS:
    old = live.get(name)
    if old is None:
        if "--skip-missing" in sys.argv:
            print(f"skip: {name} is no longer a live data file")
            continue
        sys.exit(f"ABORT: {name} is not a live data file (already repaired or recompacted?)")
    new = parquet_file_to_data_file(table.io, table.metadata, old.file_path)
    ok = (
        new.record_count == old.record_count
        and new.file_path == old.file_path
        and new.partition == old.partition
    )
    print(f"{name}\n  rows {old.record_count} -> {new.record_count}  partition {old.partition} -> {new.partition}")
    for kind in ("lower_bounds", "upper_bounds"):
        o, n = getattr(old, kind) or {}, getattr(new, kind) or {}
        for fid in sorted(set(o) | set(n)):
            if o.get(fid) != n.get(fid):
                print(f"  field {fid} {kind[:5]}: {o.get(fid)!r} -> {n.get(fid)!r}")
    if not ok:
        sys.exit("ABORT: rebuilt entry doesn't match the old one on rows, path or partition")
    pairs.append((old, new))

if not pairs:
    print("nothing to repair")
    sys.exit(0)
if not apply:
    print("dry run: rerun with --apply to commit one overwrite snapshot")
    sys.exit(0)

for attempt in range(5):
    # Fresh table and entries right before committing: the footer reads above take long
    # enough that a Pipelines append usually lands in between.
    table = cat.load_table("logs.events")
    snap = table.current_snapshot()
    live = {t.file.file_path: t.file for t in table.scan().plan_files()}
    fresh = [(live[old.file_path], new) for old, new in pairs if old.file_path in live]
    if not fresh:
        print("nothing to repair: every file was replaced since it was read")
        sys.exit(0)
    try:
        with table.transaction() as tx:
            with tx.update_snapshot().overwrite() as ow:
                for old, new in fresh:
                    ow.delete_data_file(old)
                    ow.append_data_file(new)
        break
    except (CommitFailedException, ValidationException) as e:
        print(f"attempt {attempt + 1}: lost a race with another writer, nothing changed: {str(e)[:160]}")
else:
    sys.exit(3)
if len(fresh) < len(pairs):
    print(f"replaced meanwhile, not repaired: {len(pairs) - len(fresh)} file(s)")
table = cat.load_table("logs.events")
s = table.current_snapshot()
print("committed snapshot", s.snapshot_id, "parent", s.parent_snapshot_id, s.summary)
print(f"undo: roll the table back to snapshot {snap.snapshot_id}")
