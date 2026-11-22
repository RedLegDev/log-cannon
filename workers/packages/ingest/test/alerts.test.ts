// Alerts on D1 (refs #165): the condition port, now() pinning, due logic, and
// the evaluator end to end against D1 with Basin, SaaSMail and webhooks mocked.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionError, evaluateCondition } from "../src/alerts/condition";
import { deriveService } from "../src/alerts/deliver";
import { ALERT_BATCH_SIZE, LEASE_TTL_MS, TICK_DEADLINE_MS, alertBatchMode, isDue, isQueryTimeout, retriesTimeout, pinNow, runAlerts, telemetryFor, type AlertsEnv } from "../src/alerts/evaluate";
import { acquireLease, getAlert, insertAlert, insertDestination, recordEvaluation, type AlertRow } from "../src/alerts/store";

describe("evaluateCondition (alert-worker's grammar)", () => {
  const row = { cnt: 51, zero: 0, big: "9007199254740993", ws_cnt: 2, label: "x", flag: true };

  it("compares a column with each operator", () => {
    expect(evaluateCondition("cnt > 50", row)).toBe(true);
    expect(evaluateCondition("cnt > 51", row)).toBe(false);
    expect(evaluateCondition("cnt >= 51", row)).toBe(true);
    expect(evaluateCondition("cnt <= 50", row)).toBe(false);
    expect(evaluateCondition("zero == 0", row)).toBe(true);
    expect(evaluateCondition("zero != 0", row)).toBe(false);
    expect(evaluateCondition("cnt < 52", row)).toBe(true);
    expect(evaluateCondition("  cnt>50  ", row)).toBe(true);
  });

  it("joins with && and ||", () => {
    expect(evaluateCondition("cnt > 0 && ws_cnt >= 2", row)).toBe(true);
    expect(evaluateCondition("cnt > 0 && ws_cnt >= 3", row)).toBe(false);
    expect(evaluateCondition("cnt > 100 || ws_cnt >= 2", row)).toBe(true);
  });

  it("splits on && before ||, as v1 does", () => {
    // v1 reads this as (zero == 0 || cnt > 100) && ws_cnt > 5 → false, where
    // splitting on || first (or usual precedence) would give true.
    expect(evaluateCondition("zero == 0 || cnt > 100 && ws_cnt > 5", row)).toBe(false);
  });

  it("takes a numeric string, as Basin returns past 2^53", () => {
    expect(evaluateCondition("big > 1", row)).toBe(true);
  });

  it("errors on a missing column, a non-number, a bad right-hand side or no operator", () => {
    expect(() => evaluateCondition("nope > 1", row)).toThrow(ConditionError);
    expect(() => evaluateCondition("label > 1", row)).toThrow(/cannot convert/);
    expect(() => evaluateCondition("flag == 1", row)).toThrow(/cannot convert/);
    expect(() => evaluateCondition("cnt > five", row)).toThrow(/comparison value/);
    expect(() => evaluateCondition("cnt", row)).toThrow(/could not parse/);
  });
});

describe("pinNow", () => {
  it("replaces every now() call with a timestamp literal, any case and spacing", () => {
    const at = new Date("2026-10-23T14:00:00.123Z");
    expect(pinNow("WHERE ts > now() - INTERVAL '5 minutes' AND ts <= NOW( )", at)).toBe(
      "WHERE ts > TIMESTAMP '2026-10-23T14:00:00Z' - INTERVAL '5 minutes' AND ts <= TIMESTAMP '2026-10-23T14:00:00Z'",
    );
    expect(pinNow("SELECT known_now() FROM t", at)).toBe("SELECT known_now() FROM t");
  });

  it("pins current_timestamp and current_date too, and leaves string literals alone", () => {
    const at = new Date("2026-10-23T14:00:00Z");
    expect(pinNow("WHERE ts > current_timestamp - INTERVAL '1 hour' AND ts >= current_date AND m LIKE '%now()%'", at)).toBe(
      "WHERE ts > TIMESTAMP '2026-10-23T14:00:00Z' - INTERVAL '1 hour' AND ts >= DATE '2026-10-23' AND m LIKE '%now()%'",
    );
    expect(pinNow("WHERE m = 'it''s now()' AND ts > now()", at)).toBe("WHERE m = 'it''s now()' AND ts > TIMESTAMP '2026-10-23T14:00:00Z'");
  });
});

describe("deriveService", () => {
  it("matches v1", () => {
    expect(deriveService("MyApp - Database Failures")).toBe("myapp");
    expect(deriveService("AcmeCorp Errors")).toBe("acmecorp");
  });
});

const NOW = new Date("2026-10-23T15:00:30Z");

function alertRow(over: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "a1",
    name: "Example Errors",
    description: "",
    query: "SELECT count(*) AS cnt FROM logs.events WHERE ts > now() - INTERVAL '5 minutes'",
    condition: "cnt > 0",
    interval_seconds: 60,
    cooldown_seconds: 300,
    recipients: "[]",
    destination_ids: "[]",
    subject: "s",
    enabled: 1,
    created_at: "",
    updated_at: "",
    last_triggered_at: null,
    shadow_last_triggered_at: null,
    last_run_at: null,
    last_status: null,
    last_value: null,
    last_error: null,
    last_error_reported_at: null,
    ...over,
  };
}

describe("isDue", () => {
  it("runs a never-run alert, and a 60 s alert on every tick despite jitter", () => {
    expect(isDue(alertRow(), NOW)).toBe(true);
    expect(isDue(alertRow({ last_run_at: new Date(NOW.getTime() - 58_000).toISOString() }), NOW)).toBe(true);
    expect(isDue(alertRow({ last_run_at: new Date(NOW.getTime() - 49_000).toISOString() }), NOW)).toBe(false);
    expect(isDue(alertRow({ interval_seconds: 300, last_run_at: new Date(NOW.getTime() - 120_000).toISOString() }), NOW)).toBe(false);
  });
});

describe("retriesTimeout", () => {
  const timeout = "Query error: Query exceeded 30 seconds";
  const timedOut = alertRow({ interval_seconds: 300, last_status: "error", last_error: timeout });
  it("re-runs after a first timeout in a row, and only after a timeout", () => {
    expect(retriesTimeout(timedOut, { last_status: "ok", last_error: null })).toBe(true);
    expect(retriesTimeout(timedOut, null)).toBe(true);
    expect(retriesTimeout(timedOut, { last_status: "error", last_error: "Query error: x" })).toBe(true);
    expect(retriesTimeout(alertRow({ last_status: "error", last_error: "Query error: syntax error at or near FROM" }), null)).toBe(false);
    expect(retriesTimeout(alertRow({ last_status: "ok" }), null)).toBe(false);
  });
  it("goes back to the interval after a second timeout in a row", () => {
    expect(retriesTimeout(timedOut, { last_status: "error", last_error: timeout })).toBe(false);
  });
});

describe("isQueryTimeout", () => {
  it("matches the Basin SQL timeout message and nothing else", () => {
    expect(isQueryTimeout("Query error: Query exceeded 30 seconds")).toBe(true);
    expect(isQueryTimeout("Query error: query returned no rows")).toBe(false);
    expect(isQueryTimeout("Query error: Query exceeded memory limit")).toBe(false);
    expect(isQueryTimeout(null)).toBe(false);
  });
});

describe("runAlerts against D1", () => {
  let basinRows: Record<string, unknown>[];
  let basinStatus: number;
  let basinNewestAt: string | null;
  let basinQueries: string[];
  let sent: { url: string; body: string }[];
  let deliveryStatus: number;
  let emitted: string[];
  let batchQueries: string[];
  let batchStatus: number;
  let batchRowFor: (member: number) => Record<string, unknown>;
  let freshnessQueries: number;
  let spikeRows: Record<string, unknown>[] | null;

  const baseEnv = (over: Partial<AlertsEnv> = {}): AlertsEnv => ({
    KEYS_DB: env.KEYS_DB,
    BASIN_SQL_TOKEN: "t",
    BASIN_SQL_ACCOUNT: "acct",
    BASIN_SQL_BUCKET: "bucket",
    SAASMAIL_API_KEY: "mailkey",
    SAASMAIL_API_URL: "https://mail.example.com",
    ALERT_FROM_EMAIL: "alerts@example.com",
    ALERT_LAG_SECONDS: "180",
    // The per-alert path; batching has its own tests below.
    ALERT_BATCH_MODE: "off",
    ...over,
  });

  const tick = (e: AlertsEnv, at = NOW) =>
    runAlerts(e, { now: () => at, emit: async (lines) => void emitted.push(...lines) });

  beforeEach(async () => {
    basinRows = [{ cnt: 3 }];
    basinStatus = 200;
    // Fresh: newest row after the pinned instant (NOW - 180 s).
    basinNewestAt = "2026-10-23T14:59:00.000";
    basinQueries = [];
    sent = [];
    deliveryStatus = 200;
    emitted = [];
    batchQueries = [];
    batchStatus = 200;
    batchRowFor = () => basinRows[0];
    freshnessQueries = 0;
    spikeRows = null;
    for (const t of ["alerts", "alert_destinations", "alert_evaluations", "alert_firings", "cron_leases"]) {
      await env.KEYS_DB.prepare(`DELETE FROM ${t}`).run();
    }
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://api.sql.cloudflarestorage.com/")) {
        const query = JSON.parse(String(init?.body)).query as string;
        if (query.startsWith("SELECT t0.")) {
          batchQueries.push(query);
          if (batchStatus !== 200) {
            return new Response(JSON.stringify({ success: false, errors: [{ code: 40003, message: "scan budget exceeded" }] }), { status: batchStatus });
          }
          // Member 0 is the freshness check; member i answers with batchRowFor(i), by column position.
          const row: Record<string, unknown> = {};
          for (const [, m, c] of query.matchAll(/AS "m(\d+)_(\d+)"/g)) {
            const own = Number(m) === 0 && query.includes("max(received_at)") ? { newest: basinNewestAt } : batchRowFor(Number(m));
            row[`m${m}_${c}`] = Object.values(own)[Number(c)];
          }
          return new Response(JSON.stringify({ success: true, result: { rows: [row], metrics: { bytes_scanned: 1 } } }));
        }
        if (query.includes("max(received_at)")) {
          freshnessQueries++;
          return new Response(JSON.stringify({ success: true, result: { rows: [{ newest: basinNewestAt }], metrics: { bytes_scanned: 1 } } }));
        }
        basinQueries.push(query);
        return basinStatus === 200
          ? new Response(JSON.stringify({ success: true, result: { rows: query.includes("date_trunc") && spikeRows ? spikeRows : basinRows, metrics: { bytes_scanned: 1 } } }))
          : new Response(JSON.stringify({ success: false, errors: [{ code: 40003, message: "Invalid function 'countif'" }] }), { status: basinStatus });
      }
      const body = init?.body instanceof FormData ? String(init.body.get("payload")) : String(init?.body);
      sent.push({ url, body });
      return new Response("ok", { status: deliveryStatus });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const addAlert = (over: Record<string, unknown> = {}) =>
    insertAlert(
      env.KEYS_DB,
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Example Errors",
        description: "",
        query: "SELECT count(*) AS cnt FROM logs.events WHERE ts > now() - INTERVAL '5 minutes'",
        condition: "cnt > 0",
        interval_seconds: 60,
        cooldown_seconds: 300,
        recipients: ["ops@example.com"],
        destination_ids: [],
        subject: "Example errors",
        enabled: true,
        ...over,
      } as never,
      new Date("2026-10-01T00:00:00Z"),
    );

  it("does nothing while off", async () => {
    await addAlert();
    const t = await tick(baseEnv({ ALERTS_MODE: "off" }));
    expect(t.skipped).toBe("off");
    expect(basinQueries).toHaveLength(0);
  });

  it("queries with now() pinned lag seconds back", async () => {
    await addAlert();
    await tick(baseEnv({ ALERTS_MODE: "shadow" }));
    expect(basinQueries).toEqual(["SELECT count(*) AS cnt FROM logs.events WHERE ts > TIMESTAMP '2026-10-23T14:57:30Z' - INTERVAL '5 minutes'"]);
  });

  it("shadow: records the would-send, sends nothing, and keeps its own cooldown", async () => {
    const id = await addAlert();
    const t1 = await tick(baseEnv({ ALERTS_MODE: "shadow" }));
    expect(t1.evaluated[0]).toMatchObject({ status: "triggered", wouldSend: true, sent: false, value: { cnt: 3 } });
    expect(sent).toHaveLength(0);
    const a = await getAlert(env.KEYS_DB, id);
    expect(a).toMatchObject({ last_status: "triggered", last_triggered_at: null, shadow_last_triggered_at: NOW.toISOString() });
    expect(emitted.some((l) => JSON.parse(l)["@m"] === `[${id}] Shadow would send: Example Errors`)).toBe(true);

    const t2 = await tick(baseEnv({ ALERTS_MODE: "shadow" }), new Date(NOW.getTime() + 60_000));
    expect(t2.evaluated[0]).toMatchObject({ status: "cooldown", wouldSend: false });
    const rows = (await env.KEYS_DB.prepare("SELECT status, would_send, sent, mode FROM alert_evaluations ORDER BY evaluated_at").all()).results;
    expect(rows).toEqual([
      { status: "triggered", would_send: 1, sent: 0, mode: "shadow" },
      { status: "cooldown", would_send: 0, sent: 0, mode: "shadow" },
    ]);
  });

  it("a tick that lands just short of the cooldown's end still sends", async () => {
    await addAlert({ interval_seconds: 300, cooldown_seconds: 1800 });
    await tick(baseEnv({ ALERTS_MODE: "shadow" }));
    basinNewestAt = "2026-10-23T16:00:00.000"; // fresh for the later ticks
    const early = await tick(baseEnv({ ALERTS_MODE: "shadow" }), new Date(NOW.getTime() + 1_799_650));
    expect(early.evaluated[0]).toMatchObject({ status: "triggered", wouldSend: true });
    const inside = await tick(baseEnv({ ALERTS_MODE: "shadow" }), new Date(NOW.getTime() + 1_799_650 + 1_500_000));
    expect(inside.evaluated[0]).toMatchObject({ status: "cooldown" });
  });

  it("live: delivers to the legacy recipient and starts the cooldown", async () => {
    const id = await addAlert();
    const t = await tick(baseEnv({ ALERTS_MODE: "live" }));
    expect(t.evaluated[0]).toMatchObject({ status: "triggered", sent: true, error: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://mail.example.com/api/send");
    expect(JSON.parse(sent[0].body)).toMatchObject({ to: "ops@example.com", fromAddress: "alerts@example.com", subject: "Example errors" });
    expect((await getAlert(env.KEYS_DB, id))?.last_triggered_at).toBe(NOW.toISOString());
  });

  it("live: a refused delivery does not start the cooldown, so the next tick tries again", async () => {
    const id = await addAlert();
    deliveryStatus = 500;
    const t = await tick(baseEnv({ ALERTS_MODE: "live" }));
    expect(t.evaluated[0]).toMatchObject({ status: "triggered", sent: false });
    expect(t.evaluated[0].error).toMatch(/^Dispatch failed \(cooldown not started\)/);
    expect((await getAlert(env.KEYS_DB, id))?.last_triggered_at).toBeNull();
    deliveryStatus = 200;
    const t2 = await tick(baseEnv({ ALERTS_MODE: "live" }), new Date(NOW.getTime() + 60_000));
    expect(t2.evaluated[0]).toMatchObject({ status: "triggered", sent: true });
  });

  it("live: destinations replace the recipient list; webhooks get v1's payload", async () => {
    const dest = await insertDestination(
      env.KEYS_DB,
      { name: "Hook", type: "webhook", config: JSON.stringify({ url: "https://hook.example.com/x", headers: { "X-Token": "h" } }), enabled: true },
      NOW,
    );
    await addAlert({ destination_ids: [dest] });
    await tick(baseEnv({ ALERTS_MODE: "live" }));
    expect(sent.map((s) => s.url)).toEqual(["https://hook.example.com/x"]);
    expect(JSON.parse(sent[0].body)).toMatchObject({
      alert_id: "11111111-1111-4111-8111-111111111111",
      alert_name: "Example Errors",
      service: "example",
      condition: "cnt > 0",
      triggered_at: "2026-10-23T15:00:30Z",
      query_result: { cnt: 3 },
    });
  });

  it("live: falls back to recipients when no named destination is enabled", async () => {
    await addAlert({ destination_ids: ["22222222-2222-4222-8222-222222222222"] });
    await tick(baseEnv({ ALERTS_MODE: "live" }));
    expect(sent.map((s) => s.url)).toEqual(["https://mail.example.com/api/send"]);
  });

  it("not triggered: ok, nothing sent, nothing emitted", async () => {
    basinRows = [{ cnt: 0 }];
    await addAlert();
    const t = await tick(baseEnv({ ALERTS_MODE: "live" }));
    expect(t.evaluated[0]).toMatchObject({ status: "ok" });
    expect(sent).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("an error is recorded and reported once, not on every failing tick", async () => {
    basinStatus = 400;
    const id = await addAlert();
    const t = await tick(baseEnv({ ALERTS_MODE: "shadow" }));
    expect(t.evaluated[0]).toMatchObject({ status: "error", wouldSend: false });
    expect(t.evaluated[0].error).toMatch(/^Query error: Invalid function/);
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0])).toMatchObject({ "@l": "Warning", "@m": `[${id}] Query error: Invalid function 'countif'` });
    await tick(baseEnv({ ALERTS_MODE: "shadow" }), new Date(NOW.getTime() + 60_000));
    expect(emitted).toHaveLength(1);
  });

  it("no rows and a non-numeric column are evaluation errors, never a fire", async () => {
    basinRows = [];
    await addAlert();
    expect((await tick(baseEnv({ ALERTS_MODE: "live" }))).evaluated[0]).toMatchObject({ status: "error", error: "Query error: query returned no rows" });
    basinRows = [{ cnt: "lots" }];
    const t = await tick(baseEnv({ ALERTS_MODE: "live" }), new Date(NOW.getTime() + 60_000));
    expect(t.evaluated[0].error).toMatch(/^Condition evaluation error/);
    expect(sent).toHaveLength(0);
  });

  it("runs a 5-min alert on the next tick after a first timeout, not after a second", async () => {
    await addAlert({ interval_seconds: 300 });
    const id = "11111111-1111-4111-8111-111111111111";
    const ev = (minsAgo: number, status: "ok" | "error", error: string | null) =>
      recordEvaluation(env.KEYS_DB, { alertId: id, evaluatedAt: new Date(NOW.getTime() - minsAgo * 60_000), mode: "shadow", status, wouldSend: false, sent: false, value: null, error, durationMs: 1 });
    await ev(6, "ok", null);
    await ev(1, "error", "Query error: Query exceeded 30 seconds");
    expect((await tick(baseEnv({ ALERTS_MODE: "shadow" }))).due).toBe(1);
    await env.KEYS_DB.prepare("DELETE FROM alert_evaluations").run();
    await ev(6, "error", "Query error: Query exceeded 30 seconds");
    await ev(1, "error", "Query error: Query exceeded 30 seconds");
    expect((await tick(baseEnv({ ALERTS_MODE: "shadow" }))).due).toBe(0);
  });

  it("skips alerts that aren't due and disabled ones", async () => {
    await addAlert({ interval_seconds: 300 });
    await addAlert({ id: "33333333-3333-4333-8333-333333333333", enabled: false });
    await tick(baseEnv({ ALERTS_MODE: "shadow" }));
    expect(basinQueries).toHaveLength(1);
    await tick(baseEnv({ ALERTS_MODE: "shadow" }), new Date(NOW.getTime() + 60_000));
    expect(basinQueries).toHaveLength(1);
  });

  it("live: the cooldown holds even when recording the evaluation fails", async () => {
    const id = await addAlert();
    await env.KEYS_DB.prepare("ALTER TABLE alert_evaluations RENAME TO alert_evaluations_off").run();
    try {
      await tick(baseEnv({ ALERTS_MODE: "live" }));
    } finally {
      await env.KEYS_DB.prepare("ALTER TABLE alert_evaluations_off RENAME TO alert_evaluations").run();
    }
    expect(sent).toHaveLength(1);
    expect((await getAlert(env.KEYS_DB, id))?.last_triggered_at).toBe(NOW.toISOString());
    // last_run_at never got written, so it is due again, but the cooldown stops a resend.
    const t2 = await tick(baseEnv({ ALERTS_MODE: "live" }), new Date(NOW.getTime() + 60_000));
    expect(t2.evaluated[0]).toMatchObject({ status: "cooldown" });
    expect(sent).toHaveLength(1);
  });

  // --- Firing history (refs #193) ---

  const firingRows = async () =>
    (await env.KEYS_DB.prepare("SELECT alert_id, fired_at, outcome, values_json, destinations_json, error FROM alert_firings ORDER BY fired_at, id").all())
      .results as Record<string, unknown>[];

  it("live: a delivered firing writes one row, and a cooldown hold writes another", async () => {
    const id = await addAlert();
    await tick(baseEnv({ ALERTS_MODE: "live" }));
    expect(await firingRows()).toEqual([
      {
        alert_id: id,
        fired_at: NOW.toISOString(),
        outcome: "delivered",
        values_json: '{"cnt":3}',
        destinations_json: '[{"target":"email:ops@example.com","ok":true}]',
        error: null,
      },
    ]);
    const later = new Date(NOW.getTime() + 60_000);
    expect((await tick(baseEnv({ ALERTS_MODE: "live" }), later)).evaluated[0]).toMatchObject({ status: "cooldown" });
    const rows = await firingRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ fired_at: later.toISOString(), outcome: "cooldown", destinations_json: "[]", error: null });
    expect(sent).toHaveLength(1);
  });

  it("live: a refused delivery is a failed firing with the error; a false condition writes nothing", async () => {
    await addAlert();
    deliveryStatus = 500;
    await tick(baseEnv({ ALERTS_MODE: "live" }));
    const [row] = await firingRows();
    expect(row).toMatchObject({ outcome: "failed" });
    expect(row.error).toMatch(/^Dispatch failed \(cooldown not started\): email:ops@example.com: saasmail error \(status 500\)/);
    expect(JSON.parse(row.destinations_json as string)).toEqual([{ target: "email:ops@example.com", ok: false, error: expect.stringContaining("status 500") }]);
    basinRows = [{ cnt: 0 }];
    await tick(baseEnv({ ALERTS_MODE: "live" }), new Date(NOW.getTime() + 60_000));
    expect(await firingRows()).toHaveLength(1);
  });

  it("shadow writes no firing history", async () => {
    await addAlert();
    const t = await tick(baseEnv({ ALERTS_MODE: "shadow" }));
    expect(t.evaluated[0]).toMatchObject({ status: "triggered", wouldSend: true });
    await tick(baseEnv({ ALERTS_MODE: "shadow" }), new Date(NOW.getTime() + 60_000));
    expect(await firingRows()).toEqual([]);
  });

  it("live: a failed history write is reported and the alert still sends", async () => {
    const id = await addAlert();
    await env.KEYS_DB.prepare("ALTER TABLE alert_firings RENAME TO alert_firings_off").run();
    let t;
    try {
      t = await tick(baseEnv({ ALERTS_MODE: "live" }));
    } finally {
      await env.KEYS_DB.prepare("ALTER TABLE alert_firings_off RENAME TO alert_firings").run();
    }
    expect(t.evaluated[0]).toMatchObject({ status: "triggered", sent: true });
    expect(sent).toHaveLength(1);
    expect(await getAlert(env.KEYS_DB, id)).toMatchObject({ last_triggered_at: NOW.toISOString(), last_status: "triggered" });
    const warning = emitted.map((l) => JSON.parse(l)).find((l) => l["@mt"]?.startsWith("Alert firing history not recorded"));
    expect(warning).toMatchObject({ "@l": "Warning", Firings: 1 });
  });

  it("prunes firings past 90 days on the hourly tick, and keeps the rest", async () => {
    const day = 86_400_000;
    const ins = (at: number) =>
      env.KEYS_DB.prepare("INSERT INTO alert_firings (alert_id, fired_at, outcome) VALUES ('old', ?, 'delivered')").bind(new Date(at).toISOString());
    await env.KEYS_DB.batch([ins(NOW.getTime() - 91 * day), ins(NOW.getTime() - 90 * day - 1000), ins(NOW.getTime() - 89 * day)]);
    // A minute past the hour doesn't prune.
    await tick(baseEnv({ ALERTS_MODE: "live" }), new Date("2026-10-23T15:01:30Z"));
    expect(await firingRows()).toHaveLength(3);
    await tick(baseEnv({ ALERTS_MODE: "live" }));
    expect((await firingRows()).map((r) => r.fired_at)).toEqual([new Date(NOW.getTime() - 89 * day).toISOString()]);
  });

  it("stops starting alerts at the tick deadline; the rest stay due", async () => {
    for (let i = 0; i < 3; i++) await addAlert({ id: `4444444${i}-4444-4444-8444-444444444444` });
    let t = 0;
    const res = await runAlerts(baseEnv({ ALERTS_MODE: "shadow" }), {
      now: () => NOW,
      clock: () => (t += TICK_DEADLINE_MS / 2),
      emit: async () => {},
    });
    expect(res.due).toBe(3);
    expect(res.evaluated.length).toBeLessThan(3);
  });

  it("takes over an expired lease", async () => {
    await addAlert();
    expect(await acquireLease(env.KEYS_DB, "alerts", "crashed", NOW.getTime() - LEASE_TTL_MS - 1, LEASE_TTL_MS)).toBe(true);
    const t = await tick(baseEnv({ ALERTS_MODE: "shadow" }));
    expect(t.skipped).toBeUndefined();
    expect(basinQueries).toHaveLength(1);
  });

  it("holds every alert while Basin is behind the pinned instant, and says so", async () => {
    const id = await addAlert();
    basinNewestAt = "2026-10-23T14:50:00.000"; // 7.5 min behind 14:57:30
    const t = await tick(baseEnv({ ALERTS_MODE: "live" }), new Date("2026-10-23T15:00:30Z"));
    expect(t).toMatchObject({ skipped: "basin-behind", due: 1, evaluated: [], basinNewest: "2026-10-23T14:50:00.000Z" });
    expect(basinQueries).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(JSON.parse(emitted[0])).toMatchObject({ "@l": "Warning", BehindMinutes: 8, HeldAlerts: 1 });
    expect((await getAlert(env.KEYS_DB, id))?.last_run_at).toBeNull();
    basinNewestAt = "2026-10-23T15:00:00.000";
    const t2 = await tick(baseEnv({ ALERTS_MODE: "live" }), new Date("2026-10-23T15:01:30Z"));
    expect(t2.evaluated).toHaveLength(1);
  });

  it("holds when the freshness check itself fails", async () => {
    await addAlert();
    basinNewestAt = null;
    const t = await tick(baseEnv({ ALERTS_MODE: "shadow" }));
    expect(t.skipped).toBe("basin-behind");
    expect(emitted).toHaveLength(1);
  });

  it("skips the tick while another holds the lease", async () => {
    await addAlert();
    expect(await acquireLease(env.KEYS_DB, "alerts", "other", NOW.getTime(), 60_000)).toBe(true);
    const t = await tick(baseEnv({ ALERTS_MODE: "shadow" }));
    expect(t.skipped).toBe("lease-held");
    expect(basinQueries).toHaveLength(0);
  });

  // --- Batched queries (refs #194) ---

  const SPIKE = "22222222-2222-4222-8222-222222222222";
  const addSpike = () =>
    addAlert({
      id: SPIKE,
      name: "Spike",
      query:
        "SELECT coalesce(sum(c), 0) AS cnt, count(*) AS active_minutes, coalesce(max(c), 0) AS max_1min FROM (SELECT date_trunc('minute', ts) AS m, count(*) AS c FROM logs.events WHERE ts > now() - INTERVAL '5 minutes' GROUP BY 1) t",
      condition: "active_minutes >= 3 || max_1min >= 250",
    });
  // Members after the freshness check follow the due order (insertion order here).
  const spikeSecond = (member: number) => (member === 2 ? { cnt: 9, active_minutes: 4, max_1min: 7 } : { cnt: 3 });
  const parsed = (l: string) => JSON.parse(l) as Record<string, unknown>;

  it("on: one batched query carries every due alert and the freshness check", async () => {
    await addAlert();
    await addSpike();
    batchRowFor = spikeSecond;
    const t = await tick(baseEnv({ ALERTS_MODE: "shadow", ALERT_BATCH_MODE: "on" }));
    expect(batchQueries).toHaveLength(1);
    expect(batchQueries[0]).toContain("TIMESTAMP '2026-10-23T14:57:30Z'");
    expect(basinQueries).toHaveLength(0);
    expect(freshnessQueries).toBe(0);
    const byId = Object.fromEntries(t.evaluated.map((e) => [e.alertId, e]));
    expect(byId[SPIKE]).toMatchObject({ status: "triggered", value: { cnt: 9, active_minutes: 4, max_1min: 7 } });
    expect(byId["11111111-1111-4111-8111-111111111111"]).toMatchObject({ status: "triggered", value: { cnt: 3 } });
    expect(emitted.map(parsed).some((l) => String(l["@m"]).startsWith("Alert batches"))).toBe(false);
  });

  it("on: a failed batch falls back to one query per alert, and says so", async () => {
    await addAlert();
    await addSpike();
    batchStatus = 400;
    spikeRows = [{ cnt: 9, active_minutes: 4, max_1min: 7 }];
    const t = await tick(baseEnv({ ALERTS_MODE: "shadow", ALERT_BATCH_MODE: "on" }));
    expect(batchQueries).toHaveLength(1);
    expect(basinQueries).toHaveLength(2);
    expect(freshnessQueries).toBe(1);
    expect(t.evaluated.map((e) => e.status)).toEqual(["triggered", "triggered"]);
    const summary = emitted.map(parsed).find((l) => String(l["@m"]).startsWith("Alert batches"));
    expect(summary).toMatchObject({ "@l": "Warning", BatchMode: "on", FailedBatches: 1, FailedAlerts: 2, BatchErrors: ["scan budget exceeded"] });
  });

  it("on: per-alert errors after a fallback behave as before (first timeout held back, retried next tick)", async () => {
    const id = await addAlert({ interval_seconds: 300 });
    batchStatus = 400;
    basinStatus = 400;
    const t = await tick(baseEnv({ ALERTS_MODE: "shadow", ALERT_BATCH_MODE: "on" }));
    expect(t.evaluated[0]).toMatchObject({ status: "error", error: "Query error: Invalid function 'countif'" });
    expect(emitted.map(parsed).some((l) => l["@m"] === `[${id}] Query error: Invalid function 'countif'`)).toBe(true);
  });

  it("on: an alert whose last run was a query error, or whose columns can't be read, runs alone", async () => {
    await addAlert({ query: "SELECT * FROM logs.events LIMIT 1", condition: "cnt > 0" });
    await addSpike();
    await env.KEYS_DB.prepare("UPDATE alerts SET last_status = 'error', last_error = 'Query error: query returned no rows' WHERE id = ?").bind(SPIKE).run();
    await addAlert({ id: "55555555-5555-4555-8555-555555555555", name: "Zeta" });
    batchRowFor = () => ({ cnt: 3 });
    const t = await tick(baseEnv({ ALERTS_MODE: "shadow", ALERT_BATCH_MODE: "on" }));
    expect(batchQueries).toHaveLength(1);
    expect(batchQueries[0]).not.toContain("date_trunc");
    expect(basinQueries).toHaveLength(2);
    expect(t.evaluated).toHaveLength(3);
  });

  it("on: splits more than ALERT_BATCH_SIZE due alerts over several queries", async () => {
    for (let i = 0; i < ALERT_BATCH_SIZE + 2; i++) await addAlert({ id: `66666666-6666-4666-8666-6666666666${String(i).padStart(2, "0")}` });
    const t = await tick(baseEnv({ ALERTS_MODE: "shadow", ALERT_BATCH_MODE: "on" }));
    expect(batchQueries).toHaveLength(2);
    expect(basinQueries).toHaveLength(0);
    expect(t.evaluated.filter((e) => e.status === "triggered")).toHaveLength(ALERT_BATCH_SIZE + 2);
  });

  it("on: holds the tick on the batch's own freshness answer, recording nothing", async () => {
    const id = await addAlert();
    basinNewestAt = "2026-10-23T14:50:00.000";
    const t = await tick(baseEnv({ ALERTS_MODE: "live", ALERT_BATCH_MODE: "on" }));
    expect(t).toMatchObject({ skipped: "basin-behind", evaluated: [], basinNewest: "2026-10-23T14:50:00.000Z" });
    expect(freshnessQueries).toBe(0);
    expect(sent).toHaveLength(0);
    expect((await getAlert(env.KEYS_DB, id))?.last_run_at).toBeNull();
  });

  it("shadow: the per-alert result fires, and each mismatch is reported with both sides", async () => {
    await addAlert();
    await addSpike();
    // Per alert, nothing fires; batched, the plain alert would.
    basinRows = [{ cnt: 0 }];
    spikeRows = [{ cnt: 0, active_minutes: 0, max_1min: 0 }];
    batchRowFor = (m) => (m === 2 ? spikeRows![0] : { cnt: 3 });
    const t = await tick(baseEnv({ ALERTS_MODE: "shadow", ALERT_BATCH_MODE: "shadow" }));
    expect(batchQueries).toHaveLength(1);
    expect(basinQueries).toHaveLength(2);
    expect(t.evaluated.map((e) => e.status)).toEqual(["ok", "ok"]);
    const lines = emitted.map(parsed);
    const mismatches = lines.filter((l) => l["@mt"] === "Alert batch shadow mismatch: {AlertName}");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      "@l": "Warning",
      AlertId: "11111111-1111-4111-8111-111111111111",
      PerAlert: { cnt: 0 },
      Batched: { cnt: 3 },
      PerAlertWouldFire: false,
      BatchedWouldFire: true,
    });
    expect(lines.find((l) => String(l["@m"]).startsWith("Alert batches"))).toMatchObject({
      "@l": "Warning",
      BatchMode: "shadow",
      BatchQueries: 1,
      Compared: 2,
      Mismatches: 1,
    });
  });

  it("shadow is the default, and a clean tick reports one Information summary", async () => {
    await addAlert();
    await tick(baseEnv({ ALERTS_MODE: "shadow", ALERT_BATCH_MODE: undefined }));
    expect(batchQueries).toHaveLength(1);
    expect(basinQueries).toHaveLength(1);
    expect(emitted.map(parsed).find((l) => String(l["@m"]).startsWith("Alert batches"))).toMatchObject({
      "@l": "Information",
      Compared: 1,
      Mismatches: 0,
    });
  });

  it("off: no batched query, the freshness check runs alone", async () => {
    await addAlert();
    await tick(baseEnv({ ALERTS_MODE: "shadow", ALERT_BATCH_MODE: "off" }));
    expect(batchQueries).toHaveLength(0);
    expect(freshnessQueries).toBe(1);
    expect(basinQueries).toHaveLength(1);
  });
});

describe("alertBatchMode", () => {
  it("defaults to shadow", () => {
    expect(alertBatchMode(undefined)).toBe("shadow");
    expect(alertBatchMode("bogus")).toBe("shadow");
    expect(alertBatchMode(" ON ")).toBe("on");
    expect(alertBatchMode("off")).toBe("off");
  });
});

describe("telemetryFor", () => {
  it("reports an error when it starts, then at most hourly while it persists", () => {
    const e = { alertId: "a1", evaluatedAt: NOW, mode: "shadow" as const, status: "error" as const, wouldSend: false, sent: false, value: null, error: "Query error: x", durationMs: 1 };
    const at = new Date("2026-10-23T15:05:10Z");
    expect(telemetryFor(alertRow({ last_status: "ok" }), e, at)).toHaveLength(1);
    expect(telemetryFor(alertRow({ last_status: "error", last_error_reported_at: "2026-10-23T14:20:00Z" }), e, at)).toHaveLength(0);
    expect(telemetryFor(alertRow({ last_status: "error", last_error_reported_at: "2026-10-23T14:05:00Z" }), e, at)).toHaveLength(1);
    expect(telemetryFor(alertRow({ last_status: "error", last_error_reported_at: null }), e, at)).toHaveLength(1);
  });

  it("holds back a first query timeout and reports the second in a row", () => {
    const timeout = "Query error: Query exceeded 30 seconds";
    const e = { alertId: "a1", evaluatedAt: NOW, mode: "live" as const, status: "error" as const, wouldSend: false, sent: false, value: null, error: timeout, durationMs: 30_000 };
    expect(telemetryFor(alertRow({ last_status: "ok" }), e, NOW)).toHaveLength(0);
    expect(telemetryFor(alertRow({ last_status: "error", last_error: "Query error: x" }), e, NOW)).toHaveLength(0);
    expect(telemetryFor(alertRow({ last_status: "error", last_error: timeout }), e, NOW)).toHaveLength(1);
  });
});
