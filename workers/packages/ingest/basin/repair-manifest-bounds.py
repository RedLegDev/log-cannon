"""Repair bad manifest bounds (refs #187): Basin's writers can record a string column's
upper bound from one row group instead of the whole file (check-manifest-bounds.py finds
them), and Basin SQL then prunes real rows; an `exception` bound of ''/'' makes it read the
column as '' for every row. This swaps the named data files' manifest entries for entries
rebuilt from their own Parquet footers, in one overwrite snapshot. Same files, same rows.
Dry run by default; the undo is rolling the table back to the snapshot it prints first.

  LOG_CANNON_BASIN_TOKEN=... (R2 Admin R&W)
  uv run --no-project --with "pyiceberg[pyarrow]" python -I repair-manifest-bounds.py \
      compacted-00000-....parquet [...] [--apply]

First used 2026-11-04 on the 10-26 and 11-03 files (vault: 2026-11-04 compaction bound repair).
"""

import os
import sys

from pyiceberg.catalog.rest import RestCatalog
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

if not apply:
    print("dry run: rerun with --apply to commit one overwrite snapshot")
    sys.exit(0)

with table.transaction() as tx:
    with tx.update_snapshot().overwrite() as ow:
        for old, new in pairs:
            ow.delete_data_file(old)
            ow.append_data_file(new)
table = cat.load_table("logs.events")
s = table.current_snapshot()
print("committed snapshot", s.snapshot_id, "parent", s.parent_snapshot_id, s.summary)
print(f"undo: roll the table back to snapshot {snap.snapshot_id}")
