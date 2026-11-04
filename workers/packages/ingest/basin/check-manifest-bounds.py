"""Check every live data file's manifest bounds against its own Parquet footer (refs #187).

Basin's writers (Pipelines and managed compaction, parquet-rs 58.4) record a string
column's upper bound from one row group instead of the whole file, so values above it
exist in the file. Basin SQL prunes on those bounds: `=`, `IN`, prefix `LIKE` and range
predicates on the column miss the rows, and an upper of '' (the #187 episodes, where
lower = upper = '') makes the reader treat `exception` as the constant ''. Seen
2026-11-04 on `message`, `message_template`, `properties` and `exception` in 20 of 38
live files; lower bounds and the other columns were correct. This reads each live file's
footer (row-group statistics only, no data pages) and flags any column whose manifest
bound is provably wrong:

  * upper bound below the footer's max (strings: below the footer max minus its last
    character, which stays a lower limit on the true max even when parquet truncated
    and rounded the statistic up);
  * lower bound above the footer's min (strings: compared on the footer min's length,
    since a truncated min is a prefix of the true one).

A missing bound means "unknown" to readers and is never flagged. Read-only. Prints
nothing and exits 0 when every file is clean; otherwise prints each bad file and the
repair-manifest-bounds.py command for them and exits 1. Exits 2 if the check couldn't run.

  LOG_CANNON_BASIN_SQL_READ_TOKEN=... (Basin read; LOG_CANNON_BASIN_TOKEN also works)
  uv run --no-project --with "pyiceberg[pyarrow]" python -I check-manifest-bounds.py [-v] [--snapshot ID]

--snapshot checks an older snapshot instead of the current one (to prove the check:
1809358363872105675 is the last one before the 2026-11-04 repair; its 10-26 and
11-03 compacted files have `exception` bounds ''/'').
"""

import os
import sys

import pyarrow.parquet as pq
from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.conversions import from_bytes
from pyiceberg.io.pyarrow import parquet_path_to_id_mapping
from pyiceberg.types import DoubleType, IntegerType, LongType, StringType, TimestampType, TimestamptzType

ACCOUNT = "ab1da25c524f59bc61f776304bd88558"
UNIT_US = {"MILLIS": 1_000, "MICROS": 1, "NANOS": 0.001}
verbose = "-v" in sys.argv
snapshot_id = int(sys.argv[sys.argv.index("--snapshot") + 1]) if "--snapshot" in sys.argv else None


def footer_ranges(md, ids, types):
    """{field_id: (min, max)} over all row groups, in the manifest's value space. A field
    is left out if any row group with non-null values has no min/max."""
    out, broken = {}, set()
    for rg in range(md.num_row_groups):
        group = md.row_group(rg)
        for c in range(group.num_columns):
            col = group.column(c)
            fid = ids.get(col.path_in_schema)
            if fid is None or fid not in types or fid in broken:
                continue
            st = col.statistics
            if st is None or not st.has_min_max:
                if st is None or st.null_count != group.num_rows:
                    broken.add(fid)
                    out.pop(fid, None)
                continue
            lo, hi = st.min_raw, st.max_raw
            if isinstance(types[fid], (TimestampType, TimestamptzType)):
                unit = next(u for u in UNIT_US if u in str(st.logical_type).upper())
                lo, hi = int(lo * UNIT_US[unit]), int(hi * UNIT_US[unit])
            elif isinstance(lo, bytes):
                lo, hi = lo.decode("utf-8", "replace"), hi.decode("utf-8", "replace")
            cur = out.get(fid)
            out[fid] = (lo, hi) if cur is None else (min(cur[0], lo), max(cur[1], hi))
    return out


def problems(entry, ranges, types, names):
    found = []
    for fid, (fmin, fmax) in ranges.items():
        string = isinstance(types[fid], StringType)
        up = (entry.upper_bounds or {}).get(fid)
        if up is not None:
            mup = from_bytes(types[fid], up)
            if mup < (fmax[:-1] if string else fmax):
                found.append(f"{names[fid]} upper bound {mup!r} is below the footer max {fmax[:40]!r}")
        low = (entry.lower_bounds or {}).get(fid)
        if low is not None:
            mlow = from_bytes(types[fid], low)
            if (mlow[: len(fmin)] if string else mlow) > fmin:
                found.append(f"{names[fid]} lower bound {mlow!r} is above the footer min {fmin[:40]!r}")
    return found


def main() -> int:
    token = os.environ.get("LOG_CANNON_BASIN_SQL_READ_TOKEN") or os.environ.get("LOG_CANNON_BASIN_TOKEN")
    if not token:
        print("check-manifest-bounds: no Basin token in the environment")
        return 2
    try:
        cat = RestCatalog(
            "basin",
            uri=f"https://catalog.cloudflarestorage.com/{ACCOUNT}/log-cannon-events",
            warehouse=f"{ACCOUNT}_log-cannon-events",
            token=token,
        )
        table = cat.load_table("logs.events")
        schema = table.schema()
        ids = parquet_path_to_id_mapping(schema)
        kinds = (StringType, LongType, IntegerType, DoubleType, TimestampType, TimestamptzType)
        types = {f.field_id: f.field_type for f in schema.fields if isinstance(f.field_type, kinds)}
        names = {f.field_id: f.name for f in schema.fields}
        snap = table.snapshot_by_id(snapshot_id) if snapshot_id else table.current_snapshot()
        bad = {}
        files = [t.file for t in table.scan(snapshot_id=snap.snapshot_id).plan_files()]
        for entry in files:
            md = pq.read_metadata(table.io.new_input(entry.file_path).open())
            found = problems(entry, footer_ranges(md, ids, types), types, names)
            name = entry.file_path.rsplit("/", 1)[-1]
            if found:
                bad[name] = found
            elif verbose:
                print(f"ok  {name}  rows {entry.record_count}")
    except Exception as e:  # catalog, R2 or footer read failure: say so, don't pass silently
        print(f"check-manifest-bounds: couldn't run: {type(e).__name__}: {str(e)[:300]}")
        return 2
    if verbose or bad:
        print(f"snapshot {snap.snapshot_id}: {len(files)} live files, {len(bad)} with a bad bound")
    if not bad:
        return 0
    for name, found in bad.items():
        print(f"BAD {name}")
        for f in found:
            print(f"    {f}")
    print("Repair (dry run first, then --apply; vault: 2026-11-04 compaction bound repair):")
    print("  uv run --no-project --with \"pyiceberg[pyarrow]\" python -I repair-manifest-bounds.py " + " ".join(bad))
    return 1


if __name__ == "__main__":
    sys.exit(main())
