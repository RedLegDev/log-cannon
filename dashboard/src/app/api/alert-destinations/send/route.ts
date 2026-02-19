import { NextRequest, NextResponse } from 'next/server';
import { getAlertDestinationById, EmailDestinationConfig, WebhookDestinationConfig } from '@/lib/clickhouse';

interface SendEventBody {
  destination_id: string;
  event: {
    id: string;
    timestamp: string;
    level: string;
    message: string;
    source: string;
    exception?: string;
    properties: string | Record<string, unknown>;
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: SendEventBody = await request.json();
    const { destination_id, event } = body;

    if (!destination_id) {
      return NextResponse.json({ error: 'destination_id is required' }, { status: 400 });
    }
    if (!event || !event.id) {
      return NextResponse.json({ error: 'event is required' }, { status: 400 });
    }

    const destination = await getAlertDestinationById(destination_id);
    if (!destination) {
      return NextResponse.json({ error: 'Destination not found' }, { status: 404 });
    }
    if (!destination.enabled) {
      return NextResponse.json({ error: 'Destination is disabled' }, { status: 400 });
    }

    const config = JSON.parse(destination.config);
    const parsedProps = typeof event.properties === 'string'
      ? JSON.parse(event.properties || '{}')
      : event.properties;

    const dashboardUrl = process.env.DASHBOARD_URL || 'https://logs.redleg.dev';
    const eventLink = `${dashboardUrl}/logs?id=${event.id}`;

    if (destination.type === 'webhook') {
      await sendWebhook(config as WebhookDestinationConfig, {
        alert_id: 'manual',
        alert_name: `Manual: ${event.source || 'Unknown'}`,
        description: event.message,
        query: `SELECT * FROM logs.events WHERE id = '${event.id}'`,
        condition: 'manual',
        triggered_at: event.timestamp,
        query_result: {
          id: event.id,
          level: event.level,
          message: event.message,
          source: event.source,
          exception: event.exception || '',
          properties: parsedProps,
        },
      });
    } else if (destination.type === 'email') {
      const emailConfig = config as EmailDestinationConfig;
      await sendEmail(emailConfig, event, parsedProps, eventLink);
    } else {
      return NextResponse.json({ error: `Unknown destination type: ${destination.type}` }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error sending to destination:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to send to destination' },
      { status: 500 }
    );
  }
}

async function sendWebhook(
  config: WebhookDestinationConfig,
  payload: Record<string, unknown>
): Promise<void> {
  const method = config.method || 'POST';
  const timeout = (config.timeout_seconds || 10) * 1000;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...config.headers,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(config.url, {
      method,
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Webhook returned ${res.status}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function sendEmail(
  config: EmailDestinationConfig,
  event: SendEventBody['event'],
  properties: Record<string, unknown>,
  eventLink: string
): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY not configured — cannot send email');
  }

  const fromEmail = config.from || process.env.ALERT_FROM_EMAIL || 'alerts@yourdomain.com';
  const levelColors: Record<string, string> = {
    'Fatal': '#dc2626',
    'Error': '#dc2626',
    'Warning': '#d97706',
    'Information': '#2563eb',
    'Debug': '#6b7280',
  };
  const levelColor = levelColors[event.level] || '#6b7280';

  const propsRows = Object.entries(properties)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => {
      const display = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `<tr><td style="padding:6px 12px;border-bottom:1px solid #2a2a2e;color:#d97706;font-family:monospace;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 12px;border-bottom:1px solid #2a2a2e;color:#e5e5e5;word-break:break-all">${escapeHtml(display)}</td></tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px">
  <div style="background:#141416;border:1px solid #2a2a2e;border-radius:8px;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid #2a2a2e">
      <span style="font-family:monospace;font-weight:bold;color:#fff">LOG <span style="color:#FF4D2A">CANNON</span></span>
      <span style="margin-left:12px;font-size:13px;color:#9ca3af">Event Forward</span>
    </div>
    <div style="padding:24px">
      <div style="margin-bottom:16px">
        <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;color:#fff;background:${levelColor}">${escapeHtml(event.level)}</span>
        <span style="margin-left:8px;font-size:13px;color:#9ca3af">${escapeHtml(event.source)}</span>
        <span style="margin-left:8px;font-size:13px;color:#6b7280">${escapeHtml(event.timestamp)}</span>
      </div>
      <div style="padding:12px 16px;background:#1a1a1e;border-radius:6px;margin-bottom:16px">
        <p style="margin:0;color:#e5e5e5;font-size:14px;line-height:1.5">${escapeHtml(event.message)}</p>
      </div>
      ${event.exception ? `<div style="padding:12px 16px;background:#1c0f0f;border:1px solid #7f1d1d;border-radius:6px;margin-bottom:16px"><pre style="margin:0;color:#fca5a5;font-size:12px;font-family:monospace;white-space:pre-wrap;overflow-x:auto">${escapeHtml(event.exception)}</pre></div>` : ''}
      ${propsRows ? `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">${propsRows}</table>` : ''}
      <div style="text-align:center;padding-top:8px">
        <a href="${eventLink}" style="display:inline-block;padding:8px 20px;background:#FF4D2A;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:500">View Event</a>
      </div>
    </div>
    <div style="padding:16px 24px;border-top:1px solid #2a2a2e;text-align:center">
      <span style="font-size:12px;color:#6b7280">Sent manually from Log Cannon</span>
    </div>
  </div>
</div>
</body></html>`;

  const textBody = `[${event.level}] ${event.source} — ${event.timestamp}\n\n${event.message}${event.exception ? `\n\nException:\n${event.exception}` : ''}\n\nProperties:\n${Object.entries(properties).map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')}\n\nView: ${eventLink}`;

  const subject = `[${event.level}] ${event.source}: ${event.message.slice(0, 80)}`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [config.email],
      subject,
      text: textBody,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend API returned ${res.status}: ${text.slice(0, 200)}`);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
