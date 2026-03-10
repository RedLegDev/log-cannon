import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiScope } from './api-auth';
import {
  queryClickHouse,
  getRecentLogs,
  createDashboard,
  createAlert,
  getCurrentMetrics,
  getServiceStats,
  getErrorSummary,
  getFiringAlerts,
  insertLogEvent,
} from './clickhouse';
import type { PropertyFilter } from './clickhouse';
import { getOverviewDocs, API_DOCS, LOGGER_DOCS, DASHBOARD_DOCS } from './docs-content';

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
        event_type: z.string().optional().describe('Event type identifier (MurmurHash3 hex hash of message_template, e.g. "0x5432a8ff"). Auto-computed at ingest if omitted.'),
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

    server.registerTool('get_docs', {
      title: 'Get Documentation',
      description: 'Get log-cannon documentation. Returns API reference, logger integration guide, dashboard/widget schema, or a system overview with live data (active sources, log levels, property keys). Use this to understand how to interact with log-cannon before calling other tools.',
      inputSchema: {
        section: z.enum(['overview', 'api', 'logger', 'dashboards']).describe(
          'Which documentation section: "overview" (system overview + live data), "api" (REST API reference), "logger" (CLEF logger integration guide), "dashboards" (dashboard & widget schema)'
        ),
      },
    }, async (args) => {
      try {
        let content: string;
        switch (args.section) {
          case 'overview':
            content = await getOverviewDocs();
            break;
          case 'api':
            content = API_DOCS;
            break;
          case 'logger':
            content = LOGGER_DOCS;
            break;
          case 'dashboards':
            content = DASHBOARD_DOCS;
            break;
        }
        return { content: [{ type: 'text' as const, text: content }] };
      } catch (e) {
        return errorResult(`Failed to get documentation: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  // ── Write tools ────────────────────────────────────────────

  if (canWrite) {
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

  }

  return server;
}
