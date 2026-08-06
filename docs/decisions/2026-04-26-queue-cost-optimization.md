# Queue cost optimization investigation

**Date:** April 26, 2026
**Status:** Investigated, not implemented
**Trigger:** Cloudflare billing showing Queues at ~$21.60 / 20 days (~67% of total CF spend)

## Context

Log Cannon ingests via Cloudflare Workers → Cloudflare Queue → Go consumer → ClickHouse on a self-hosted server. Queue ops dominate the bill. Investigated whether to drop the queue.

## Numbers at the time (annualized)

- Queues — Standard ops: ~81M billable/month → **~$32/mo**
- Workers Standard Requests: ~44M billable/month → ~$12/mo
- R2 Data Storage: ~$3/mo
- Workers CPU ms: ~$1/mo
- **Total CF spend: ~$49/mo projected**

Each ingest message = 3 queue ops (write + read + ack). ~27M ingest messages/month. Most requests aren't chunked — chunking isn't the cost multiplier; raw request volume is.

## Options considered

### Option A — Drop queue, Worker writes directly to ClickHouse via Cloudflare Tunnel + Access service token

Architecturally clean (zero-trust to the backing server) but ClickHouse hates per-request inserts. Would still need a buffering layer. Rejected for that reason.

### Option B — Drop queue, Worker writes raw bodies to R2, ClickHouse pulls via `s3()` table function

- R2 has an S3-compat API — ClickHouse can read it natively with `s3('https://<acct>.r2.cloudflarestorage.com/<bucket>/incoming/...', JSONEachRow)`
- R2 Class A writes: $4.50/M (vs queue ops at $0.40/M — **11x more expensive per op**)
- 27M direct writes/month × $4.50/M = **~$122/mo** — worse than queues.

### Option C — Worker → Durable Object batcher → R2 → ClickHouse

DO buffers ~30s or ~5MB per source, flushes one R2 object per flush.

- DO requests: 27M × $0.15/M = ~$4/mo
- DO duration: ~17k GB-s, well under the 400k free tier = $0
- R2 writes (10 sources × 2,880 flushes/day): ~864k/mo × $4.50/M = ~$4/mo
- R2 reads (ClickHouse pulling): ~$0.30/mo
- **Total: ~$8-11/mo**

**Net savings: ~$21-24/mo, ~$250-290/yr.**

## Why we didn't do it

1. **Payback doesn't justify the rewrite.** $250/yr savings against multi-day work: TS Worker rewrite, new Durable Object class, ClickHouse ingestion path (cron or refreshable MV), a dedup table, plus porting OTLP protobuf parsing somewhere (CLEF/NDJSON works natively in `s3()`; protobuf does not). Easily a year+ of payback.
2. **New failure modes.** DO flush failures, R2 list/dedup edge cases, latency goes from seconds to minutes.
3. **Current architecture is fine for the value.** ~$32/mo for queues is less than a streaming subscription.

## What changes the calculus

The math becomes compelling at 3-5x current volume — at that point queue cost is $100+/mo and savings hit $70-80/mo. Watch for:

- Queue line item crosses **$75/mo** (suggested budget alert threshold)
- Ingest request volume doubles from current ~27M/mo
- A new high-volume producer is onboarded

## If we do build it later — sketch

**Worker side** (`workers/packages/ingest`):

- Replace `INGEST_QUEUE` binding with an R2 bucket + Durable Object binding in `wrangler.toml`
- Drop chunking logic entirely (no 128KB cap on R2)
- Each handler forwards to a per-source DO; DO buffers and flushes to R2 with key `incoming/<format>/dt=YYYY-MM-DD/hh=HH/<source>/<ulid>.{ndjson,bin}`

**ClickHouse side:**

- Generate an R2 S3-compat token
- `processed_files(key, processed_at)` dedup table
- Refreshable materialized view or scheduled `INSERT INTO logs.events SELECT ... FROM s3(...)`
- R2 lifecycle rule: delete after 90 days

**Queue consumer:** delete entirely, OR repurpose as a "list new keys, parse OTLP protobuf, write JSONEachRow to a parsed/ prefix" janitor (since ClickHouse can't parse OTLP protobuf natively).
