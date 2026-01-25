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

export interface PropertyFilter {
  key: string;
  value: string;
  exclude: boolean;
}

export async function getRecentLogs(
  source?: string,
  level?: string,
  search?: string,
  propertyFilters?: PropertyFilter[],
  limit: number = 100
): Promise<LogEvent[]> {
  let conditions = ['e.timestamp > now() - INTERVAL 24 HOUR'];

  if (source) {
    conditions.push(`e.source = '${escapeString(source)}'`);
  }

  if (level) {
    conditions.push(`e.level = '${escapeString(level)}'`);
  }

  if (search) {
    conditions.push(`e.message LIKE '%${escapeString(search)}%'`);
  }

  if (propertyFilters && propertyFilters.length > 0) {
    for (const filter of propertyFilters) {
      const jsonValue = escapeString(filter.value);
      const jsonKey = escapeString(filter.key);
      if (filter.exclude) {
        conditions.push(`JSONExtractString(e.properties, '${jsonKey}') != '${jsonValue}'`);
      } else {
        conditions.push(`JSONExtractString(e.properties, '${jsonKey}') = '${jsonValue}'`);
      }
    }
  }

  const sql = `
    SELECT
      toString(e.id) as id,
      formatDateTime(e.timestamp, '%Y-%m-%d %H:%i:%S') as timestamp,
      e.level,
      e.message_template,
      e.message,
      e.exception,
      e.event_type,
      e.source,
      e.properties
    FROM logs.events e
    WHERE ${conditions.join(' AND ')}
    ORDER BY e.timestamp DESC
    LIMIT ${limit}
  `;

  return queryClickHouse<LogEvent>(sql);
}

export async function getServiceStats(): Promise<ServiceStats[]> {
  const sql = `
    SELECT
      e.source as source,
      count(*) as total_count,
      countIf(e.level IN ('Error', 'Fatal')) as error_count,
      formatDateTime(max(e.timestamp), '%Y-%m-%d %H:%i:%S') as last_log
    FROM logs.events e
    WHERE e.timestamp > now() - INTERVAL 24 HOUR
    GROUP BY e.source
    ORDER BY total_count DESC
  `;

  return queryClickHouse<ServiceStats>(sql);
}

export async function getTimeSeries(minutes: number = 60): Promise<TimeSeriesPoint[]> {
  const sql = `
    SELECT
      formatDateTime(toStartOfMinute(e.timestamp), '%Y-%m-%d %H:%i:%S') as minute,
      count(*) as count,
      countIf(e.level IN ('Error', 'Fatal')) as errors
    FROM logs.events e
    WHERE e.timestamp > now() - INTERVAL ${minutes} MINUTE
    GROUP BY toStartOfMinute(e.timestamp)
    ORDER BY toStartOfMinute(e.timestamp)
  `;

  return queryClickHouse<TimeSeriesPoint>(sql);
}

export async function getSources(): Promise<string[]> {
  const sql = `
    SELECT DISTINCT e.source as source
    FROM logs.events e
    WHERE e.timestamp > now() - INTERVAL 24 HOUR
    ORDER BY source
  `;

  const results = await queryClickHouse<{source: string}>(sql);
  return results.map(r => r.source);
}

function escapeString(str: string): string {
  return str.replace(/'/g, "\\'").replace(/\\/g, '\\\\');
}

export interface APIKey {
  key_id: string;
  api_key: string;
  name: string;
  created_at: string;
  enabled: number;
}

export async function getAPIKeys(): Promise<APIKey[]> {
  const sql = `
    SELECT
      toString(key_id) as key_id,
      api_key,
      name,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at,
      enabled
    FROM logs.api_keys
    ORDER BY created_at DESC
  `;

  return queryClickHouse<APIKey>(sql);
}

export async function createAPIKey(name: string): Promise<string> {
  const apiKey = generateAPIKey();
  const sql = `
    INSERT INTO logs.api_keys (api_key, name, enabled)
    VALUES ('${escapeString(apiKey)}', '${escapeString(name)}', 1)
  `;

  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });

  return apiKey;
}

export async function toggleAPIKey(keyId: string, enabled: boolean): Promise<void> {
  const sql = `
    ALTER TABLE logs.api_keys
    UPDATE enabled = ${enabled ? 1 : 0}
    WHERE key_id = '${escapeString(keyId)}'
  `;

  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });
}

export async function deleteAPIKey(keyId: string): Promise<void> {
  const sql = `
    ALTER TABLE logs.api_keys
    DELETE WHERE key_id = '${escapeString(keyId)}'
  `;

  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });
}

function generateAPIKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
