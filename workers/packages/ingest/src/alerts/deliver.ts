// Alert delivery (refs #165): email through the SaaSMail HTTP API and JSON
// webhooks, with v1 alert-worker's payloads. v2 has no dashboard, so the
// email drops v1's "View Alert Settings" / "Search Logs" links.

import { parseJsonArray, type AlertRow, type DestinationRow } from "./store";

export interface DeliveryEnv {
  SAASMAIL_API_KEY?: string;
  SAASMAIL_API_URL?: string;
  ALERT_FROM_EMAIL?: string;
}

export interface DeliveryResult {
  delivered: number;
  attempts: { target: string; ok: boolean; error?: string }[];
}

type Fetch = typeof fetch;

const EMAIL_TIMEOUT_MS = 30_000;
const DEFAULT_WEBHOOK_TIMEOUT_S = 10;
/** One slow webhook must not hold the evaluator's tick past its lease. */
const MAX_WEBHOOK_TIMEOUT_S = 30;

/**
 * Send to the alert's destinations, falling back to its legacy recipient list
 * when it names none or none resolve, as v1 does. The caller starts the
 * cooldown only when `delivered > 0`.
 */
export async function deliverAlert(
  env: DeliveryEnv,
  alert: AlertRow,
  destinations: DestinationRow[],
  row: Record<string, unknown>,
  now: Date,
  doFetch: Fetch = fetch,
): Promise<DeliveryResult> {
  const result: DeliveryResult = { delivered: 0, attempts: [] };
  const record = (target: string, p: Promise<void>) =>
    p.then(
      () => {
        result.delivered++;
        result.attempts.push({ target, ok: true });
      },
      (e: unknown) => {
        result.attempts.push({ target, ok: false, error: e instanceof Error ? e.message : String(e) });
      },
    );
  const { text, html } = formatAlertBody(alert, row, now);
  const from = env.ALERT_FROM_EMAIL || "alerts@example.com";

  const named = parseJsonArray(alert.destination_ids);
  if (named.length && destinations.length) {
    for (const d of destinations) {
      if (d.type === "email") {
        const cfg = parseConfig<{ email?: string; from?: string }>(d.config);
        if (!cfg?.email) {
          result.attempts.push({ target: `dest:${d.id}`, ok: false, error: "bad email config" });
          continue;
        }
        await record(`email:${cfg.email}`, sendEmail(env, cfg.from || from, cfg.email, alert.subject, text, html, doFetch));
      } else if (d.type === "webhook") {
        const cfg = parseConfig<WebhookConfig>(d.config);
        if (!cfg?.url) {
          result.attempts.push({ target: `dest:${d.id}`, ok: false, error: "bad webhook config" });
          continue;
        }
        await record(`webhook:${d.name}`, sendWebhook(cfg, webhookPayload(alert, row, now), doFetch));
      } else {
        result.attempts.push({ target: `dest:${d.id}`, ok: false, error: `unknown destination type ${d.type}` });
      }
    }
    return result;
  }

  for (const to of parseJsonArray(alert.recipients)) {
    await record(`email:${to}`, sendEmail(env, from, to, alert.subject, text, html, doFetch));
  }
  return result;
}

function parseConfig<T>(s: string): T | null {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

interface WebhookConfig {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  timeout_seconds?: number;
}

export function webhookPayload(alert: AlertRow, row: Record<string, unknown>, now: Date) {
  return {
    alert_id: alert.id,
    alert_name: alert.name,
    service: deriveService(alert.name),
    description: alert.description,
    query: alert.query,
    condition: alert.condition,
    triggered_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    query_result: row,
  };
}

async function sendWebhook(cfg: WebhookConfig, payload: unknown, doFetch: Fetch): Promise<void> {
  const timeout = Math.min(cfg.timeout_seconds && cfg.timeout_seconds > 0 ? cfg.timeout_seconds : DEFAULT_WEBHOOK_TIMEOUT_S, MAX_WEBHOOK_TIMEOUT_S);
  const method = (cfg.method || "POST").toUpperCase();
  const res = await doFetch(cfg.url!, {
    method,
    // v1 lets a destination's headers override Content-Type.
    headers: { "Content-Type": "application/json", ...cfg.headers },
    // fetch refuses a body on GET/HEAD; Go sent one. Nothing reads it there.
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout * 1000),
  });
  if (res.status >= 400) throw new Error(`webhook error (status ${res.status}): ${(await res.text()).slice(0, 300)}`);
  await res.body?.cancel();
}

async function sendEmail(
  env: DeliveryEnv,
  from: string,
  to: string,
  subject: string,
  text: string,
  html: string,
  doFetch: Fetch,
): Promise<void> {
  if (!env.SAASMAIL_API_KEY || !env.SAASMAIL_API_URL) throw new Error("SAASMAIL_API_KEY / SAASMAIL_API_URL not set");
  const form = new FormData();
  form.set("payload", JSON.stringify({ to, fromAddress: from, subject, bodyText: text, bodyHtml: html }));
  const res = await doFetch(`${env.SAASMAIL_API_URL.replace(/\/+$/, "")}/api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SAASMAIL_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
  });
  if (res.status >= 400) throw new Error(`saasmail error (status ${res.status}): ${(await res.text()).slice(0, 300)}`);
  await res.body?.cancel();
}

/** "MyApp - Database Failures" → "myapp", as v1 derives the webhook `service`. */
export function deriveService(alertName: string): string {
  let name = alertName.toLowerCase();
  for (const sep of [" - ", " errors", " alert", " warning"]) {
    const at = name.indexOf(sep);
    if (at > 0) {
      name = name.slice(0, at);
      break;
    }
  }
  return name.trim().replace(/[^a-z0-9-]/g, "");
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function show(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function formatAlertBody(alert: AlertRow, row: Record<string, unknown>, now: Date): { text: string; html: string } {
  const entries = Object.entries(row);
  const text = [
    `Alert: ${alert.name}`,
    `Time: ${now.toISOString()}`,
    `Description: ${alert.description}`,
    "",
    "Query Result:",
    ...entries.map(([k, v]) => `  ${k}: ${show(v)}`),
    "",
    "Query:",
    alert.query,
    "",
  ].join("\n");

  const cell = "padding: 8px 12px; border-bottom: 1px solid #2a2a2e; font-family: 'JetBrains Mono', Monaco, 'Courier New', monospace; font-size: 13px;";
  const rows = entries
    .map(
      ([k, v]) =>
        `<tr><td style="${cell} color: #a0a0a5;">${escapeHTML(k)}</td><td style="${cell} color: #ffffff; font-weight: 600;">${escapeHTML(show(v))}</td></tr>`,
    )
    .join("");
  const triggered = now.toUTCString();
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHTML(alert.subject)}</title></head>
<body style="margin: 0; padding: 0; background-color: #0a0a0b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
<table role="presentation" style="width: 100%; border-collapse: collapse;"><tr><td align="center" style="padding: 40px 20px;">
<table role="presentation" style="width: 100%; max-width: 600px; border-collapse: collapse;">
<tr><td style="padding: 24px 32px; background: #141416; border-radius: 12px 12px 0 0; border-bottom: 2px solid #FF4D2A;">
<span style="font-size: 18px; font-weight: 700; color: #ffffff;">LOG <span style="color: #FF4D2A;">CANNON</span></span>
<span style="float: right; padding: 6px 12px; border: 1px solid #FF4D2A; border-radius: 6px; color: #FF4D2A; font-size: 12px; font-weight: 600; text-transform: uppercase;">Alert Triggered</span>
</td></tr>
<tr><td style="padding: 32px; background-color: #141416;">
<h1 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 700; color: #ffffff;">${escapeHTML(alert.name)}</h1>
<p style="margin: 0 0 24px 0; font-size: 14px; color: #a0a0a5;">${escapeHTML(alert.description)}</p>
<p style="margin: 0 0 24px 0; padding: 16px; background-color: #1a1a1e; border-left: 3px solid #FF4D2A; color: #ffffff; font-size: 16px;">Triggered ${escapeHTML(triggered)}</p>
<h2 style="margin: 0 0 12px 0; font-size: 14px; color: #a0a0a5; text-transform: uppercase;">Query Results</h2>
<table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #1a1a1e; margin-bottom: 24px;">${rows}</table>
<h2 style="margin: 0 0 12px 0; font-size: 14px; color: #a0a0a5; text-transform: uppercase;">Query</h2>
<div style="padding: 16px; background-color: #0a0a0b; border: 1px solid #2a2a2e;"><code style="font-family: 'JetBrains Mono', Monaco, 'Courier New', monospace; font-size: 12px; color: #e0e0e5; white-space: pre-wrap; word-break: break-all;">${escapeHTML(alert.query)}</code></div>
</td></tr>
</table></td></tr></table>
</body>
</html>`;
  return { text, html };
}
