// Alerts on D1 (refs #165): the condition port, now() pinning, due logic, and
// the evaluator end to end against D1 with Basin, SaaSMail and webhooks mocked.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionError, evaluateCondition } from "../src/alerts/condition";
import { deriveService } from "../src/alerts/deliver";
import { isDue, pinNow, runAlerts, telemetryFor, type AlertsEnv } from "../src/alerts/evaluate";
import { acquireLease, getAlert, insertAlert, insertDestination, type AlertRow } from "../src/alerts/store";

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
    // v1 reads this as (cnt > 100 || zero == 0) && ws_cnt > 5 → false, where
    // usual precedence would give true.
    expect(evaluateCondition("cnt > 100 || zero == 0 && ws_cnt > 5", row)).toBe(false);
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
    ...over,
  };
}

describe("isDue", () => {
  it("runs a never-run alert, and a 60 s alert on every tick despite jitter", () => {
    expect(isDue(alertRow(), NOW)).toBe(true);
    expect(isDue(alertRow({ last_run_at: new Date(NOW.getTime() - 58_000).toISOString() }), NOW)).toBe(true);
    expect(isDue(alertRow({ interval_seconds: 300, last_run_at: new Date(NOW.getTime() - 120_000).toISOString() }), NOW)).toBe(false);
  });
});

describe("runAlerts against D1", () => {
  let basinRows: Record<string, unknown>[];
  let basinStatus: number;
  let basinQueries: string[];
  let sent: { url: string; body: string }[];
  let deliveryStatus: number;
  let emitted: string[];

  const baseEnv = (over: Partial<AlertsEnv> = {}): AlertsEnv => ({
    KEYS_DB: env.KEYS_DB,
    BASIN_SQL_TOKEN: "t",
    BASIN_SQL_ACCOUNT: "acct",
    BASIN_SQL_BUCKET: "bucket",
    SAASMAIL_API_KEY: "mailkey",
    SAASMAIL_API_URL: "https://mail.example.com",
    ALERT_FROM_EMAIL: "alerts@example.com",
    ALERT_LAG_SECONDS: "180",
    ...over,
  });

  const tick = (e: AlertsEnv, at = NOW) =>
    runAlerts(e, { now: () => at, emit: async (lines) => void emitted.push(...lines) });

  beforeEach(async () => {
    basinRows = [{ cnt: 3 }];
    basinStatus = 200;
    basinQueries = [];
    sent = [];
    deliveryStatus = 200;
    emitted = [];
    for (const t of ["alerts", "alert_destinations", "alert_evaluations", "cron_leases"]) {
      await env.KEYS_DB.prepare(`DELETE FROM ${t}`).run();
    }
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://api.sql.cloudflarestorage.com/")) {
        basinQueries.push(JSON.parse(String(init?.body)).query);
        return basinStatus === 200
          ? new Response(JSON.stringify({ success: true, result: { rows: basinRows, metrics: { bytes_scanned: 1 } } }))
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

  it("skips alerts that aren't due and disabled ones", async () => {
    await addAlert({ interval_seconds: 300 });
    await addAlert({ id: "33333333-3333-4333-8333-333333333333", enabled: false });
    await tick(baseEnv({ ALERTS_MODE: "shadow" }));
    expect(basinQueries).toHaveLength(1);
    await tick(baseEnv({ ALERTS_MODE: "shadow" }), new Date(NOW.getTime() + 60_000));
    expect(basinQueries).toHaveLength(1);
  });

  it("skips the tick while another holds the lease", async () => {
    await addAlert();
    expect(await acquireLease(env.KEYS_DB, "alerts", "other", NOW.getTime(), 60_000)).toBe(true);
    const t = await tick(baseEnv({ ALERTS_MODE: "shadow" }));
    expect(t.skipped).toBe("lease-held");
    expect(basinQueries).toHaveLength(0);
  });
});

describe("telemetryFor", () => {
  it("reports a persisting error again on the hour", () => {
    const e = { alertId: "a1", evaluatedAt: NOW, mode: "shadow" as const, status: "error" as const, wouldSend: false, sent: false, value: null, error: "Query error: x", durationMs: 1 };
    expect(telemetryFor(alertRow({ last_status: "error" }), e, new Date("2026-10-23T15:05:10Z"))).toHaveLength(0);
    expect(telemetryFor(alertRow({ last_status: "ok" }), e, new Date("2026-10-23T15:05:10Z"))).toHaveLength(1);
    expect(telemetryFor(alertRow({ last_status: "error" }), e, new Date("2026-10-23T16:00:10Z"))).toHaveLength(1);
  });
});
