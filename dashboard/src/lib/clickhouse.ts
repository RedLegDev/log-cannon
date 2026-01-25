const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123';

export interface LogEvent {
  id: string;
  timestamp: string;
  level: string;
  message_template: string;
  message: string;
  exception: string;
  event_type: string;
  source: string;
  properties: string;
}

export interface ServiceStats {
  source: string;
  total_count: number;
  error_count: number;
  last_log: string;
}

export interface TimeSeriesPoint {
  minute: string;
  count: number;
  errors: number;
}

export async function queryClickHouse<T>(sql: string): Promise<T[]> {
  const response = await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: `${sql} FORMAT JSON`,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickHouse query failed: ${errorText}`);
  }

  const result = await response.json();
  return result.data;
}

export async function getRecentLogs(
  source?: string,
  level?: string,
  search?: string,
  limit: number = 100
): Promise<LogEvent[]> {
  let conditions = ['timestamp > now() - INTERVAL 24 HOUR'];

  if (source) {
    conditions.push(`source = '${escapeString(source)}'`);
  }

  if (level) {
    conditions.push(`level = '${escapeString(level)}'`);
  }

  if (search) {
    conditions.push(`message LIKE '%${escapeString(search)}%'`);
  }

  const sql = `
    SELECT
      toString(id) as id,
      toString(timestamp) as timestamp,
      level,
      message_template,
      message,
      exception,
      event_type,
      source,
      properties
    FROM logs.events
    WHERE ${conditions.join(' AND ')}
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `;

  return queryClickHouse<LogEvent>(sql);
}

export async function getServiceStats(): Promise<ServiceStats[]> {
  const sql = `
    SELECT
      source,
      count(*) as total_count,
      countIf(level IN ('Error', 'Fatal')) as error_count,
      toString(max(timestamp)) as last_log
    FROM logs.events
    WHERE timestamp > now() - INTERVAL 24 HOUR
    GROUP BY source
    ORDER BY total_count DESC
  `;

  return queryClickHouse<ServiceStats>(sql);
}

export async function getTimeSeries(minutes: number = 60): Promise<TimeSeriesPoint[]> {
  const sql = `
    SELECT
      toString(toStartOfMinute(timestamp)) as minute,
      count(*) as count,
      countIf(level IN ('Error', 'Fatal')) as errors
    FROM logs.events
    WHERE timestamp > now() - INTERVAL ${minutes} MINUTE
    GROUP BY minute
    ORDER BY minute
  `;

  return queryClickHouse<TimeSeriesPoint>(sql);
}

export async function getSources(): Promise<string[]> {
  const sql = `
    SELECT DISTINCT source
    FROM logs.events
    WHERE timestamp > now() - INTERVAL 24 HOUR
    ORDER BY source
  `;

  const results = await queryClickHouse<{source: string}>(sql);
  return results.map(r => r.source);
}

function escapeString(str: string): string {
  return str.replace(/'/g, "\\'").replace(/\\/g, '\\\\');
}
