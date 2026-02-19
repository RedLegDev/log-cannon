import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiScope } from './api-auth';
import {
  queryClickHouse,
  getRecentLogs,
  deleteLogs,
  getDashboards,
  getDashboardByName,
  createDashboard,
  updateDashboard,
  deleteDashboard,
  getAlerts,
  createAlert,
  updateAlert,
  deleteAlert,
  getAlertDestinations,
  getAlertDestinationById,
  createAlertDestination,
  updateAlertDestination,
  deleteAlertDestination,
  getCurrentMetrics,
  getServiceStats,
  getTopServicesByErrors,
  getErrorSummary,
  getLogVolume,
  getFiringAlerts,
  insertLogEvent,
} from './clickhouse';
import type { PropertyFilter, EmailDestinationConfig, WebhookDestinationConfig } from './clickhouse';

const SCOPE_HIERARCHY: Record<ApiScope, ApiScope[]> = {
  admin: ['admin', 'write', 'read', 'ingest'],
  write: ['write', 'read', 'ingest'],
  read: ['read', 'ingest'],
  ingest: ['ingest'],
};

function hasScope(scopes: ApiScope[], required: ApiScope): boolean {
  return scopes.some(s => SCOPE_HIERARCHY[s]?.includes(required));
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function createMcpServer(scopes: ApiScope[]): McpServer {
  const server = new McpServer({
    name: 'log-cannon',
    version: '1.0.0',
  });

  const canIngest = hasScope(scopes, 'ingest');
  const canRead = hasScope(scopes, 'read');
  const canWrite = hasScope(scopes, 'write');

  // ── Ingest tools ───────────────────────────────────────────

  if (canIngest) {
    server.registerTool('create_log', {
      title: 'Create Log Entry',
      description: 'Create a log entry in Log Cannon. Use this to record agent activity, task progress, errors, or any structured event. The entry appears immediately in the log explorer.',
      inputSchema: {
        level: z.enum(['Verbose', 'Debug', 'Information', 'Warning', 'Error', 'Fatal']).describe('Log level'),
        message: z.string().describe('Log message text'),
        source: z.string().describe('Source/service name (e.g. "my-agent", "build-bot")'),
        message_template: z.string().optional().describe('Structured message template with {Placeholder} tokens (e.g. "Task {TaskName} completed in {Duration}ms")'),
        exception: z.string().optional().describe('Exception/stack trace text'),
        event_type: z.string().optional().describe('Event type identifier'),
        properties: z.record(z.string(), z.any()).optional().describe('Structured properties as key-value pairs (e.g. {"TaskName": "deploy", "Duration": 1234})'),
      },
    }, async (args) => {
      try {
        await insertLogEvent({
          level: args.level,
          message: args.message,
          source: args.source,
          message_template: args.message_template,
          exception: args.exception,
          event_type: args.event_type,
          properties: args.properties as Record<string, unknown> | undefined,
        });
        return jsonResult({ success: true, message: 'Log entry created' });
      } catch (e) {
        return errorResult(`Failed to create log entry: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  // ── Read tools ─────────────────────────────────────────────

  if (canRead) {
    server.registerTool('search_logs', {
      title: 'Search Logs',
      description: 'Search and filter log events by source, level, text, and property filters. Returns up to 1000 results from the last 24 hours by default.',
      inputSchema: {
        source: z.string().optional().describe('Filter by source/service name'),
        level: z.string().optional().describe('Filter by log level (e.g. Error, Warning, Information, Debug)'),
        search: z.string().optional().describe('Full-text search across message content'),
        limit: z.number().min(1).max(1000).optional().describe('Max results to return (default 100, max 1000)'),
        property_filters: z.array(z.object({
          key: z.string().describe('Property key (supports dot notation, e.g. metrics.latency)'),
          value: z.string().describe('Value to compare against'),
          operator: z.enum(['=', '!=', '>', '>=', '<', '<=']).optional().describe('Comparison operator (default =)'),
        })).optional().describe('Filter by structured log properties'),
      },
    }, async (args) => {
      try {
        const propFilters: PropertyFilter[] = (args.property_filters || []).map(f => ({
          key: f.key,
          value: f.value,
          operator: f.operator || '=',
        }));
        const logs = await getRecentLogs(
          args.source, args.level, args.search,
          propFilters, undefined, args.limit || 100,
        );
        const data = logs.map(log => ({
          id: log.id,
          timestamp: log.timestamp,
          level: log.level,
          message: log.message,
          message_template: log.message_template,
          source: log.source,
          exception: log.exception || undefined,
          properties: log.properties ? JSON.parse(log.properties) : {},
        }));
        return jsonResult({ data, meta: { count: data.length, limit: args.limit || 100 } });
      } catch (e) {
        return errorResult(`Failed to search logs: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('execute_query', {
      title: 'Execute SQL Query',
      description: 'Execute a read-only SQL SELECT query against the ClickHouse logs database. Auto-limited to 10,000 rows with 30-second timeout. The main table is logs.events with columns: id, timestamp, level, message_template, message, exception, event_type, source, properties.',
      inputSchema: {
        sql: z.string().describe('SELECT query to execute (only SELECT statements allowed)'),
      },
    }, async (args) => {
      try {
        const trimmed = args.sql.trim().toLowerCase();
        if (!trimmed.startsWith('select')) {
          return errorResult('Only SELECT statements are allowed');
        }
        const hasLimit = /\blimit\s+\d+/i.test(args.sql);
        const limitedSql = hasLimit ? args.sql : `${args.sql} LIMIT 10000`;
        const start = Date.now();
        const data = await queryClickHouse<unknown>(limitedSql);
        return jsonResult({ data, meta: { rows: Array.isArray(data) ? data.length : 0, elapsed_ms: Date.now() - start } });
      } catch (e) {
        return errorResult(`Query failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('list_dashboards', {
      title: 'List Dashboards',
      description: 'List all configured dashboards with their widget configurations.',
      inputSchema: {},
    }, async () => {
      try {
        const dashboards = await getDashboards();
        const data = dashboards.map(d => ({
          id: d.id, name: d.name, description: d.description,
          config: JSON.parse(d.config), enabled: Boolean(d.enabled),
          created_at: d.created_at, updated_at: d.updated_at,
        }));
        return jsonResult({ data });
      } catch (e) {
        return errorResult(`Failed to list dashboards: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('get_dashboard', {
      title: 'Get Dashboard',
      description: 'Get a specific dashboard by name, including its full widget configuration.',
      inputSchema: {
        name: z.string().describe('Dashboard name (URL-safe identifier)'),
      },
    }, async (args) => {
      try {
        const d = await getDashboardByName(args.name);
        if (!d) return errorResult(`Dashboard not found: ${args.name}`);
        return jsonResult({
          id: d.id, name: d.name, description: d.description,
          config: JSON.parse(d.config), enabled: Boolean(d.enabled),
          created_at: d.created_at, updated_at: d.updated_at,
        });
      } catch (e) {
        return errorResult(`Failed to get dashboard: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('list_alerts', {
      title: 'List Alerts',
      description: 'List all alert rules with their query, condition, and notification settings.',
      inputSchema: {},
    }, async () => {
      try {
        const alerts = await getAlerts();
        const data = alerts.map(a => ({
          id: a.id, name: a.name, description: a.description,
          query: a.query, condition: a.condition,
          interval_seconds: a.interval_seconds, cooldown_seconds: a.cooldown_seconds,
          recipients: JSON.parse(a.recipients || '[]'),
          destination_ids: JSON.parse(a.destination_ids || '[]'),
          subject: a.subject,
          enabled: Boolean(a.enabled), created_at: a.created_at,
          last_triggered_at: a.last_triggered_at,
        }));
        return jsonResult({ data });
      } catch (e) {
        return errorResult(`Failed to list alerts: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('list_destinations', {
      title: 'List Alert Destinations',
      description: 'List all alert destinations (email and webhook targets). Destinations are reusable notification targets that can be assigned to multiple alerts or triggered manually from the log explorer.',
      inputSchema: {},
    }, async () => {
      try {
        const destinations = await getAlertDestinations();
        const data = destinations.map(d => ({
          id: d.id, name: d.name, type: d.type,
          config: JSON.parse(d.config || '{}'),
          enabled: Boolean(d.enabled), created_at: d.created_at,
        }));
        return jsonResult({ data });
      } catch (e) {
        return errorResult(`Failed to list destinations: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    // ── Investigation tools ────────────────────────────────────

    server.registerTool('get_overview', {
      title: 'Get Overview',
      description: 'One-shot investigation starter. Returns current metrics (logs/min, error rate, active services), service breakdown with error counts, and top error message templates — all for the last 24 hours. Start here before drilling into specific issues.',
      inputSchema: {},
    }, async () => {
      try {
        const [metrics, services, topErrors] = await Promise.all([
          getCurrentMetrics(),
          getServiceStats(),
          getErrorSummary(undefined, 24, 10),
        ]);
        return jsonResult({ metrics, services, top_errors: topErrors });
      } catch (e) {
        return errorResult(`Failed to get overview: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('get_service_overview', {
      title: 'Get Service Overview',
      description: 'List all sources/services with log counts, error counts, error rates, and last seen timestamp. Sorted by error count descending.',
      inputSchema: {
        limit: z.number().min(1).max(100).optional().describe('Max services to return (default 20)'),
      },
    }, async (args) => {
      try {
        const data = await getTopServicesByErrors(args.limit || 20);
        return jsonResult({ data });
      } catch (e) {
        return errorResult(`Failed to get service overview: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('get_error_summary', {
      title: 'Get Error Summary',
      description: 'Errors and warnings grouped by message template with counts, latest timestamp, and a sample message. Much more compact than searching raw error logs. Use this instead of search_logs when you want to understand what types of errors are occurring.',
      inputSchema: {
        source: z.string().optional().describe('Filter to a specific source/service'),
        hours: z.number().min(1).max(168).optional().describe('Lookback period in hours (default 24, max 168)'),
        limit: z.number().min(1).max(100).optional().describe('Max error groups to return (default 20)'),
      },
    }, async (args) => {
      try {
        const data = await getErrorSummary(args.source, args.hours || 24, args.limit || 20);
        return jsonResult({ data });
      } catch (e) {
        return errorResult(`Failed to get error summary: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('get_log_volume', {
      title: 'Get Log Volume',
      description: 'Time-series log volume broken down by level (total, errors, warnings, info). Use granularity parameter to control bucket size: "minute" for last-hour detail, "hour" for daily trends, "day" for weekly view.',
      inputSchema: {
        source: z.string().optional().describe('Filter to a specific source/service'),
        hours: z.number().min(1).max(168).optional().describe('Lookback period in hours (default 24, max 168)'),
        granularity: z.enum(['minute', 'hour', 'day']).optional().describe('Time bucket size (default "hour")'),
      },
    }, async (args) => {
      try {
        const data = await getLogVolume(args.source, args.hours || 24, args.granularity || 'hour');
        return jsonResult({ data });
      } catch (e) {
        return errorResult(`Failed to get log volume: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('get_firing_alerts', {
      title: 'Get Firing Alerts',
      description: 'Check if any alert rules are currently firing (triggered within their cooldown period). Quick way to identify active incidents.',
      inputSchema: {},
    }, async () => {
      try {
        const data = await getFiringAlerts();
        return jsonResult({ data, firing_count: data.length });
      } catch (e) {
        return errorResult(`Failed to get firing alerts: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  // ── Write tools ────────────────────────────────────────────

  if (canWrite) {
    server.registerTool('delete_logs', {
      title: 'Delete Logs',
      description: 'Delete logs matching the given filters. At least one filter is required.',
      inputSchema: {
        source: z.string().optional().describe('Filter by source/service name'),
        level: z.string().optional().describe('Filter by log level'),
        search: z.string().optional().describe('Full-text search filter'),
        property_filters: z.array(z.object({
          key: z.string(),
          value: z.string(),
          operator: z.enum(['=', '!=', '>', '>=', '<', '<=']).optional(),
        })).optional().describe('Property filters'),
      },
      annotations: { destructiveHint: true },
    }, async (args) => {
      try {
        if (!args.source && !args.level && !args.search && (!args.property_filters || args.property_filters.length === 0)) {
          return errorResult('At least one filter (source, level, search, or property_filters) is required');
        }
        const propFilters: PropertyFilter[] = (args.property_filters || []).map(f => ({
          key: f.key, value: f.value, operator: f.operator || '=',
        }));
        const deleted = await deleteLogs(args.source, args.level, args.search, propFilters);
        return jsonResult({ message: `Deleted ${deleted} log(s)`, meta: { deleted } });
      } catch (e) {
        return errorResult(`Failed to delete logs: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('create_dashboard', {
      title: 'Create Dashboard',
      description: 'Create a new dashboard. Requires a name (URL-safe), optional description, and a config with layout and widgets. Widget types: stat, line_chart, bar_chart, pie_chart, doughnut_chart, scatter_chart, table.',
      inputSchema: {
        name: z.string().regex(/^[a-zA-Z0-9_-]+$/).describe('URL-safe dashboard name'),
        description: z.string().optional().describe('Dashboard description'),
        config: z.object({
          layout: z.enum(['auto', 'grid']).describe('Layout mode'),
          widgets: z.array(z.any()).min(1).describe('Array of widget configurations'),
        }).describe('Dashboard configuration with layout and widgets'),
      },
    }, async (args) => {
      try {
        await createDashboard({ name: args.name, description: args.description, config: args.config });
        return jsonResult({ success: true, name: args.name });
      } catch (e) {
        return errorResult(`Failed to create dashboard: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('update_dashboard', {
      title: 'Update Dashboard',
      description: 'Update an existing dashboard by name. Only provided fields are updated.',
      inputSchema: {
        name: z.string().describe('Dashboard name to update'),
        new_name: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe('New name'),
        description: z.string().optional().describe('New description'),
        config: z.object({
          layout: z.enum(['auto', 'grid']),
          widgets: z.array(z.any()).min(1),
        }).optional().describe('New configuration'),
        enabled: z.boolean().optional().describe('Enable/disable'),
      },
    }, async (args) => {
      try {
        const d = await getDashboardByName(args.name);
        if (!d) return errorResult(`Dashboard not found: ${args.name}`);
        const updates: Record<string, unknown> = {};
        if (args.new_name !== undefined) updates.name = args.new_name;
        if (args.description !== undefined) updates.description = args.description;
        if (args.config !== undefined) updates.config = args.config;
        if (args.enabled !== undefined) updates.enabled = args.enabled;
        if (Object.keys(updates).length === 0) return errorResult('No fields to update');
        await updateDashboard(d.id, updates);
        return jsonResult({ success: true });
      } catch (e) {
        return errorResult(`Failed to update dashboard: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('delete_dashboard', {
      title: 'Delete Dashboard',
      description: 'Delete a dashboard by name.',
      inputSchema: {
        name: z.string().describe('Dashboard name to delete'),
      },
      annotations: { destructiveHint: true },
    }, async (args) => {
      try {
        const d = await getDashboardByName(args.name);
        if (!d) return errorResult(`Dashboard not found: ${args.name}`);
        await deleteDashboard(d.id);
        return jsonResult({ success: true });
      } catch (e) {
        return errorResult(`Failed to delete dashboard: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('create_alert', {
      title: 'Create Alert',
      description: 'Create a threshold alert rule. The query must be a SELECT returning numeric values. The condition evaluates column names from query results (e.g. "cnt > 50", "errors >= 100 && total > 1000"). Use destination_ids to assign reusable notification targets.',
      inputSchema: {
        name: z.string().describe('Alert name'),
        description: z.string().optional().describe('Alert description'),
        query: z.string().describe('SELECT query returning values for condition evaluation'),
        condition: z.string().describe('Condition expression (e.g. "cnt > 50")'),
        interval_seconds: z.number().min(30).optional().describe('Check interval in seconds (min 30, default 60)'),
        cooldown_seconds: z.number().optional().describe('Min seconds between repeated alerts (default 300)'),
        destination_ids: z.array(z.string()).optional().describe('Alert destination UUIDs to notify (preferred over recipients)'),
        recipients: z.array(z.string()).optional().describe('Email addresses to notify (legacy — use destination_ids instead)'),
        subject: z.string().describe('Email subject line'),
      },
    }, async (args) => {
      try {
        if (!args.query.trim().toLowerCase().startsWith('select')) {
          return errorResult('query must be a SELECT statement');
        }
        if (!args.destination_ids?.length && !args.recipients?.length) {
          return errorResult('At least one destination_id or recipient is required');
        }
        await createAlert({
          name: args.name, description: args.description,
          query: args.query, condition: args.condition,
          interval_seconds: args.interval_seconds,
          cooldown_seconds: args.cooldown_seconds,
          destination_ids: args.destination_ids,
          recipients: args.recipients, subject: args.subject,
        });
        return jsonResult({ success: true });
      } catch (e) {
        return errorResult(`Failed to create alert: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('update_alert', {
      title: 'Update Alert',
      description: 'Update an existing alert rule. Only provided fields are changed.',
      inputSchema: {
        id: z.string().describe('Alert ID to update'),
        name: z.string().optional().describe('New name'),
        description: z.string().optional().describe('New description'),
        query: z.string().optional().describe('New SELECT query'),
        condition: z.string().optional().describe('New condition expression'),
        interval_seconds: z.number().min(30).optional().describe('New check interval'),
        cooldown_seconds: z.number().optional().describe('New cooldown'),
        destination_ids: z.array(z.string()).optional().describe('New destination UUIDs'),
        recipients: z.array(z.string()).optional().describe('New recipients (legacy)'),
        subject: z.string().optional().describe('New subject'),
        enabled: z.boolean().optional().describe('Enable/disable'),
      },
    }, async (args) => {
      try {
        const { id, enabled, ...rest } = args;
        if (rest.query && !rest.query.trim().toLowerCase().startsWith('select')) {
          return errorResult('query must be a SELECT statement');
        }
        const updates: Record<string, unknown> = { ...rest };
        if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;
        await updateAlert(id, updates);
        return jsonResult({ success: true });
      } catch (e) {
        return errorResult(`Failed to update alert: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('delete_alert', {
      title: 'Delete Alert',
      description: 'Delete an alert rule by ID.',
      inputSchema: {
        id: z.string().describe('Alert ID to delete'),
      },
      annotations: { destructiveHint: true },
    }, async (args) => {
      try {
        await deleteAlert(args.id);
        return jsonResult({ success: true });
      } catch (e) {
        return errorResult(`Failed to delete alert: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('create_destination', {
      title: 'Create Alert Destination',
      description: 'Create a reusable alert destination. Email destinations require config.email. Webhook destinations require config.url and support custom method, headers, and timeout.',
      inputSchema: {
        name: z.string().describe('Destination name (e.g. "Ops Team Email", "Make Webhook")'),
        type: z.enum(['email', 'webhook']).describe('Destination type'),
        config: z.record(z.string(), z.any()).describe('Type-specific config: email needs {email, from?}, webhook needs {url, method?, headers?, timeout_seconds?}'),
      },
    }, async (args) => {
      try {
        if (args.type === 'email' && !args.config.email) {
          return errorResult('Email destinations require config.email');
        }
        if (args.type === 'webhook' && !args.config.url) {
          return errorResult('Webhook destinations require config.url');
        }
        await createAlertDestination({
          name: args.name,
          type: args.type,
          config: args.config as EmailDestinationConfig | WebhookDestinationConfig,
        });
        return jsonResult({ success: true });
      } catch (e) {
        return errorResult(`Failed to create destination: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('update_destination', {
      title: 'Update Alert Destination',
      description: 'Update an existing alert destination. Only provided fields are changed.',
      inputSchema: {
        id: z.string().describe('Destination ID to update'),
        name: z.string().optional().describe('New name'),
        type: z.enum(['email', 'webhook']).optional().describe('New type'),
        config: z.record(z.string(), z.any()).optional().describe('New config'),
        enabled: z.boolean().optional().describe('Enable/disable'),
      },
    }, async (args) => {
      try {
        const { id, ...updates } = args;
        await updateAlertDestination(id, updates as Parameters<typeof updateAlertDestination>[1]);
        return jsonResult({ success: true });
      } catch (e) {
        return errorResult(`Failed to update destination: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('delete_destination', {
      title: 'Delete Alert Destination',
      description: 'Delete an alert destination by ID.',
      inputSchema: {
        id: z.string().describe('Destination ID to delete'),
      },
      annotations: { destructiveHint: true },
    }, async (args) => {
      try {
        await deleteAlertDestination(args.id);
        return jsonResult({ success: true });
      } catch (e) {
        return errorResult(`Failed to delete destination: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool('send_to_destination', {
      title: 'Send Event to Destination',
      description: 'Manually send a log event to an alert destination. Useful for testing webhook integrations or escalating specific events. Webhook destinations receive the same payload schema as alert-triggered webhooks.',
      inputSchema: {
        destination_id: z.string().describe('Destination UUID to send to'),
        event: z.object({
          id: z.string().describe('Log event ID'),
          timestamp: z.string().describe('Event timestamp'),
          level: z.string().describe('Log level'),
          message: z.string().describe('Log message'),
          source: z.string().describe('Source/service name'),
          exception: z.string().optional().describe('Exception text'),
          properties: z.record(z.string(), z.any()).optional().describe('Event properties'),
        }).describe('Log event to send'),
      },
    }, async (args) => {
      try {
        const dest = await getAlertDestinationById(args.destination_id);
        if (!dest) return errorResult('Destination not found');
        if (!dest.enabled) return errorResult('Destination is disabled');

        const config = JSON.parse(dest.config);

        if (dest.type === 'webhook') {
          const webhookConfig = config as WebhookDestinationConfig;
          const method = webhookConfig.method || 'POST';
          const timeout = (webhookConfig.timeout_seconds || 10) * 1000;
          const headers: Record<string, string> = { 'Content-Type': 'application/json', ...webhookConfig.headers };
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const res = await fetch(webhookConfig.url, {
              method, headers,
              body: JSON.stringify({
                alert_id: 'manual',
                alert_name: `Manual: ${args.event.source}`,
                description: args.event.message,
                query: `SELECT * FROM logs.events WHERE id = '${args.event.id}'`,
                condition: 'manual',
                triggered_at: args.event.timestamp,
                query_result: {
                  id: args.event.id, level: args.event.level,
                  message: args.event.message, source: args.event.source,
                  exception: args.event.exception || '',
                  properties: args.event.properties || {},
                },
              }),
              signal: controller.signal,
            });
            if (!res.ok) {
              const text = await res.text().catch(() => '');
              return errorResult(`Webhook returned ${res.status}: ${text.slice(0, 200)}`);
            }
          } finally {
            clearTimeout(timer);
          }
          return jsonResult({ success: true, destination: dest.name, type: 'webhook' });
        } else if (dest.type === 'email') {
          const emailConfig = config as EmailDestinationConfig;
          const resendApiKey = process.env.RESEND_API_KEY;
          if (!resendApiKey) return errorResult('RESEND_API_KEY not configured');
          const fromEmail = emailConfig.from || process.env.ALERT_FROM_EMAIL || 'alerts@yourdomain.com';
          const subject = `[${args.event.level}] ${args.event.source}: ${args.event.message.slice(0, 80)}`;
          const dashboardUrl = process.env.DASHBOARD_URL || 'https://logs.redleg.dev';
          const text = `[${args.event.level}] ${args.event.source} — ${args.event.timestamp}\n\n${args.event.message}\n\nView: ${dashboardUrl}/logs?id=${args.event.id}`;
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: fromEmail, to: [emailConfig.email], subject, text }),
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            return errorResult(`Resend API returned ${res.status}: ${errText.slice(0, 200)}`);
          }
          return jsonResult({ success: true, destination: dest.name, type: 'email' });
        }
        return errorResult(`Unknown destination type: ${dest.type}`);
      } catch (e) {
        return errorResult(`Failed to send to destination: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

  }

  return server;
}
