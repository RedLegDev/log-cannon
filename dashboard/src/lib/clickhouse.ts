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

  const text = await response.text();
  if (!text) {
    return [];
  }

  const result = JSON.parse(text);
  return result.data;
}

export type PropertyOperator = '=' | '!=' | '>' | '>=' | '<' | '<=';

export interface PropertyFilter {
  key: string;
  value: string;
  operator: PropertyOperator;
}

export interface TimeFilter {
  start?: Date | null;
  end?: Date | null;
}

// Parse operator from value string (e.g., ">5" -> { operator: ">", value: "5" })
export function parseOperatorFromValue(rawValue: string): { operator: PropertyOperator; value: string } {
  if (rawValue.startsWith('>=')) return { operator: '>=', value: rawValue.slice(2) };
  if (rawValue.startsWith('<=')) return { operator: '<=', value: rawValue.slice(2) };
  if (rawValue.startsWith('!=')) return { operator: '!=', value: rawValue.slice(2) };
  if (rawValue.startsWith('>')) return { operator: '>', value: rawValue.slice(1) };
  if (rawValue.startsWith('<')) return { operator: '<', value: rawValue.slice(1) };
  return { operator: '=', value: rawValue };
}

function escapeString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Build JSON extraction SQL for nested paths (e.g., "metrics.End_to_End" -> JSONExtract with path)
// Handles both:
// 1. Nested JSON objects: JSONExtract(props, 'metrics', 'latency')
// 2. JSON strings that contain JSON: JSONExtract(JSONExtract(props, 'item'), 'AccountId')
function buildJsonExtractSql(columnName: string, path: string, valueType: 'string' | 'number'): string {
  const parts = path.split('.');
  if (parts.length === 1) {
    // Simple top-level property
    return valueType === 'number'
      ? `JSONExtractFloat(${columnName}, '${escapeString(parts[0])}')`
      : `JSONExtractString(${columnName}, '${escapeString(parts[0])}')`;
  }

  // For nested paths, try both approaches:
  // 1. Direct nested extraction (for actual nested objects)
  // 2. Extract first key as string, then parse as JSON (for JSON strings)
  const pathArgs = parts.map(p => `'${escapeString(p)}'`).join(', ');
  const firstKey = `'${escapeString(parts[0])}'`;
  const restPathArgs = parts.slice(1).map(p => `'${escapeString(p)}'`).join(', ');

  if (valueType === 'number') {
    // Try direct nested path first, then try parsing first key as JSON string
    return `coalesce(
      nullIf(JSONExtractFloat(${columnName}, ${pathArgs}), 0),
      JSONExtractFloat(JSONExtractString(${columnName}, ${firstKey}), ${restPathArgs})
    )`;
  } else {
    // Try direct nested path first, then try parsing first key as JSON string
    return `coalesce(
      nullIf(JSONExtractString(${columnName}, ${pathArgs}), ''),
      JSONExtractString(JSONExtractString(${columnName}, ${firstKey}), ${restPathArgs})
    )`;
  }
}

// Determine if a value looks like a number
function isNumericValue(value: string): boolean {
  return !isNaN(Number(value)) && value.trim() !== '';
}

export async function getLogById(id: string): Promise<LogEvent | null> {
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
    WHERE e.id = '${escapeString(id)}'
    LIMIT 1
  `;

  const results = await queryClickHouse<LogEvent>(sql);
  return results.length > 0 ? results[0] : null;
}

export async function getRecentLogs(
  source?: string,
  level?: string,
  search?: string,
  propertyFilters?: PropertyFilter[],
  timeFilter?: TimeFilter,
  limit: number = 100
): Promise<LogEvent[]> {
  const conditions: string[] = [];

  // Time filtering
  if (timeFilter?.start) {
    const startTs = timeFilter.start.toISOString().replace('T', ' ').slice(0, 19);
    conditions.push(`e.timestamp >= parseDateTimeBestEffort('${startTs}')`);
  }
  if (timeFilter?.end) {
    const endTs = timeFilter.end.toISOString().replace('T', ' ').slice(0, 19);
    conditions.push(`e.timestamp <= parseDateTimeBestEffort('${endTs}')`);
  }
  // Default to last 24 hours if no time filter
  if (!timeFilter || (!timeFilter.start && !timeFilter.end)) {
    conditions.push('e.timestamp > now() - INTERVAL 24 HOUR');
  }

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
      const isNumeric = isNumericValue(filter.value);
      const jsonExtract = buildJsonExtractSql('e.properties', filter.key, isNumeric ? 'number' : 'string');
      const escapedValue = escapeString(filter.value);

      if (isNumeric) {
        // Numeric comparison
        conditions.push(`${jsonExtract} ${filter.operator} ${escapedValue}`);
      } else {
        // String comparison (only = and != make sense)
        const op = filter.operator === '!=' ? '!=' : '=';
        conditions.push(`${jsonExtract} ${op} '${escapedValue}'`);
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

export async function getSources(timeFilter?: TimeFilter): Promise<string[]> {
  const conditions: string[] = [];

  if (timeFilter?.start) {
    const startTs = timeFilter.start.toISOString().replace('T', ' ').slice(0, 19);
    conditions.push(`e.timestamp >= parseDateTimeBestEffort('${startTs}')`);
  }
  if (timeFilter?.end) {
    const endTs = timeFilter.end.toISOString().replace('T', ' ').slice(0, 19);
    conditions.push(`e.timestamp <= parseDateTimeBestEffort('${endTs}')`);
  }
  if (conditions.length === 0) {
    conditions.push('e.timestamp > now() - INTERVAL 24 HOUR');
  }

  const sql = `
    SELECT DISTINCT e.source as source
    FROM logs.events e
    WHERE ${conditions.join(' AND ')}
    ORDER BY source
  `;

  const results = await queryClickHouse<{source: string}>(sql);
  return results.map(r => r.source);
}

export interface APIKey {
  key_id: string;
  api_key: string;
  name: string;
  scopes: string;
  created_at: string;
  enabled: number;
  retention_days: number;
}

export async function getAPIKeys(): Promise<APIKey[]> {
  const sql = `
    SELECT
      toString(key_id) as key_id,
      api_key,
      name,
      scopes,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at,
      enabled,
      retention_days
    FROM logs.api_keys
    ORDER BY created_at DESC
  `;

  return queryClickHouse<APIKey>(sql);
}

export async function getAPIKey(keyId: string): Promise<APIKey | null> {
  const sql = `
    SELECT
      toString(key_id) as key_id,
      api_key,
      name,
      scopes,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at,
      enabled,
      retention_days
    FROM logs.api_keys
    WHERE key_id = '${escapeString(keyId)}'
    LIMIT 1
  `;

  const results = await queryClickHouse<APIKey>(sql);
  return results.length > 0 ? results[0] : null;
}

export async function createAPIKey(name: string, scopes: string = 'ingest'): Promise<string> {
  const apiKey = generateAPIKey();
  const sql = `
    INSERT INTO logs.api_keys (api_key, name, scopes, enabled)
    VALUES ('${escapeString(apiKey)}', '${escapeString(name)}', '${escapeString(scopes)}', 1)
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

async function executeClickHouse(sql: string): Promise<void> {
  const response = await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickHouse query failed: ${errorText}`);
  }
}

export async function renameAPIKey(keyId: string, name: string): Promise<void> {
  await executeClickHouse(`
    ALTER TABLE logs.api_keys
    UPDATE name = '${escapeString(name)}'
    WHERE key_id = '${escapeString(keyId)}'
  `);
}

export async function setAPIKeyRetention(keyId: string, days: number): Promise<void> {
  // Clamp to a non-negative integer; 0 = keep forever.
  const safeDays = Math.max(0, Math.floor(Number.isFinite(days) ? days : 0));
  await executeClickHouse(`
    ALTER TABLE logs.api_keys
    UPDATE retention_days = ${safeDays}
    WHERE key_id = '${escapeString(keyId)}'
  `);
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

// Saved Queries

export interface SavedQuery {
  id: string;
  name: string;
  description: string;
  source: string;
  level: string;
  search: string;
  property_filters: string;
  created_at: string;
}

export async function getSavedQueries(): Promise<SavedQuery[]> {
  const sql = `
    SELECT
      toString(id) as id,
      name,
      description,
      source,
      level,
      search,
      property_filters,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at
    FROM logs.saved_queries
    ORDER BY created_at DESC
  `;

  return queryClickHouse<SavedQuery>(sql);
}

export interface SavedQueryInput {
  name: string;
  description?: string;
  source?: string;
  level?: string;
  search?: string;
  propertyFilters?: PropertyFilter[];
}

export async function createSavedQuery(query: SavedQueryInput): Promise<void> {
  const propertyFiltersJson = JSON.stringify(query.propertyFilters || []);
  const sql = `
    INSERT INTO logs.saved_queries (name, description, source, level, search, property_filters)
    VALUES (
      '${escapeString(query.name)}',
      '${escapeString(query.description || '')}',
      '${escapeString(query.source || '')}',
      '${escapeString(query.level || '')}',
      '${escapeString(query.search || '')}',
      '${escapeString(propertyFiltersJson)}'
    )
  `;

  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });
}

export async function deleteSavedQuery(id: string): Promise<void> {
  const sql = `
    ALTER TABLE logs.saved_queries
    DELETE WHERE id = '${escapeString(id)}'
  `;

  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });
}

// Endpoints

export interface Endpoint {
  id: string;
  name: string;
  description: string;
  sql_query: string;
  cache_ttl_seconds: number;
  enabled: number;
  created_at: string;
}

export async function getEndpoints(): Promise<Endpoint[]> {
  const sql = `
    SELECT
      toString(id) as id,
      name,
      description,
      sql_query,
      cache_ttl_seconds,
      enabled,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at
    FROM logs.endpoints
    ORDER BY created_at DESC
  `;

  return queryClickHouse<Endpoint>(sql);
}

export async function getEndpointByName(name: string): Promise<Endpoint | null> {
  const sql = `
    SELECT
      toString(id) as id,
      name,
      description,
      sql_query,
      cache_ttl_seconds,
      enabled,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at
    FROM logs.endpoints
    WHERE name = '${escapeString(name)}'
    LIMIT 1
  `;

  const results = await queryClickHouse<Endpoint>(sql);
  return results.length > 0 ? results[0] : null;
}

export interface EndpointInput {
  name: string;
  description?: string;
  sql_query: string;
  cache_ttl_seconds?: number;
}

export async function createEndpoint(endpoint: EndpointInput): Promise<void> {
  const sql = `
    INSERT INTO logs.endpoints (name, description, sql_query, cache_ttl_seconds)
    VALUES (
      '${escapeString(endpoint.name)}',
      '${escapeString(endpoint.description || '')}',
      '${escapeString(endpoint.sql_query)}',
      ${endpoint.cache_ttl_seconds || 0}
    )
  `;

  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });
}

export async function updateEndpoint(id: string, updates: Partial<EndpointInput> & { enabled?: boolean }): Promise<void> {
  const setClauses: string[] = [];

  if (updates.name !== undefined) {
    setClauses.push(`name = '${escapeString(updates.name)}'`);
  }
  if (updates.description !== undefined) {
    setClauses.push(`description = '${escapeString(updates.description)}'`);
  }
  if (updates.sql_query !== undefined) {
    setClauses.push(`sql_query = '${escapeString(updates.sql_query)}'`);
  }
  if (updates.cache_ttl_seconds !== undefined) {
    setClauses.push(`cache_ttl_seconds = ${updates.cache_ttl_seconds}`);
  }
  if (updates.enabled !== undefined) {
    setClauses.push(`enabled = ${updates.enabled ? 1 : 0}`);
  }

  if (setClauses.length === 0) return;

  const sql = `
    ALTER TABLE logs.endpoints
    UPDATE ${setClauses.join(', ')}
    WHERE id = '${escapeString(id)}'
  `;

  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });
}

export async function deleteEndpoint(id: string): Promise<void> {
  const sql = `
    ALTER TABLE logs.endpoints
    DELETE WHERE id = '${escapeString(id)}'
  `;

  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });
}

export async function executeEndpointQuery(sqlQuery: string, params: Record<string, string>): Promise<unknown[]> {
  // Interpolate @param placeholders
  let interpolatedSql = sqlQuery;
  for (const [key, value] of Object.entries(params)) {
    // Only allow alphanumeric parameter names
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    const placeholder = new RegExp(`@${key}\\b`, 'g');
    interpolatedSql = interpolatedSql.replace(placeholder, `'${escapeString(value)}'`);
  }

  // Security: Only allow SELECT statements
  const trimmed = interpolatedSql.trim().toLowerCase();
  if (!trimmed.startsWith('select')) {
    throw new Error('Only SELECT statements are allowed');
  }

  return queryClickHouse<unknown>(interpolatedSql);
}

// Dashboards

export type WidgetType = 'stat' | 'line_chart' | 'bar_chart' | 'pie_chart' | 'doughnut_chart' | 'scatter_chart' | 'table';
export type LayoutType = 'auto' | 'grid';

export interface WidgetPosition {
  row: number;
  col: number;
  width: number;
  height: number;
}

export interface WidgetDataSource {
  type: 'endpoint' | 'inline';
  endpointName?: string;
  sql?: string;
  params?: Record<string, string>;
  refreshInterval?: number;
}

export interface WidgetVisualization {
  // Common
  valueField?: string;
  trend?: boolean;
  format?: 'number' | 'percent' | 'duration';

  // Charts
  xField?: string;
  yField?: string | string[];
  colors?: string[];
  xAxisFormat?: 'auto' | 'time' | 'date' | 'datetime' | 'string';
  seriesField?: string;

  // Table
  columns?: string[];
  sortBy?: string;
}

export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  position?: WidgetPosition;
  dataSource: WidgetDataSource;
  visualization?: WidgetVisualization;
}

export interface DashboardConfig {
  layout: LayoutType;
  widgets: Widget[];
}

export interface Dashboard {
  id: string;
  name: string;
  description: string;
  config: string;  // JSON string
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface DashboardInput {
  name: string;
  description?: string;
  config: DashboardConfig;
}

export async function getDashboards(): Promise<Dashboard[]> {
  const sql = `
    SELECT
      toString(id) as id,
      name,
      description,
      config,
      enabled,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at,
      formatDateTime(updated_at, '%Y-%m-%d %H:%i:%S') as updated_at
    FROM logs.dashboards
    ORDER BY created_at DESC
  `;

  return queryClickHouse<Dashboard>(sql);
}

export async function getDashboardByName(name: string): Promise<Dashboard | null> {
  const sql = `
    SELECT
      toString(id) as id,
      name,
      description,
      config,
      enabled,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at,
      formatDateTime(updated_at, '%Y-%m-%d %H:%i:%S') as updated_at
    FROM logs.dashboards
    WHERE name = '${escapeString(name)}'
    LIMIT 1
  `;

  const results = await queryClickHouse<Dashboard>(sql);
  return results.length > 0 ? results[0] : null;
}

export async function createDashboard(dashboard: DashboardInput): Promise<void> {
  const configJson = JSON.stringify(dashboard.config);
  const sql = `
    INSERT INTO logs.dashboards (name, description, config)
    VALUES (
      '${escapeString(dashboard.name)}',
      '${escapeString(dashboard.description || '')}',
      '${escapeString(configJson)}'
    )
  `;

  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });
}

export async function updateDashboard(id: string, updates: Partial<DashboardInput> & { enabled?: boolean }): Promise<void> {
  const setClauses: string[] = [];

  if (updates.name !== undefined) {
    setClauses.push(`name = '${escapeString(updates.name)}'`);
  }
  if (updates.description !== undefined) {
    setClauses.push(`description = '${escapeString(updates.description)}'`);
  }
  if (updates.config !== undefined) {
    const configJson = JSON.stringify(updates.config);
    setClauses.push(`config = '${escapeString(configJson)}'`);
  }
  if (updates.enabled !== undefined) {
    setClauses.push(`enabled = ${updates.enabled ? 1 : 0}`);
  }

  if (setClauses.length === 0) return;

  setClauses.push(`updated_at = now()`);

  const sql = `
    ALTER TABLE logs.dashboards
    UPDATE ${setClauses.join(', ')}
    WHERE id = '${escapeString(id)}'
  `;

  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });
}

export async function deleteDashboard(id: string): Promise<void> {
  const sql = `
    ALTER TABLE logs.dashboards
    DELETE WHERE id = '${escapeString(id)}'
  `;

  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });
}

export async function executeWidgetQuery(widget: Widget): Promise<unknown[]> {
  if (widget.dataSource.type === 'endpoint') {
    // Use existing endpoint system
    if (!widget.dataSource.endpointName) {
      throw new Error('Endpoint name is required for endpoint data source');
    }

    const endpoint = await getEndpointByName(widget.dataSource.endpointName);
    if (!endpoint) {
      throw new Error(`Endpoint not found: ${widget.dataSource.endpointName}`);
    }

    if (!endpoint.enabled) {
      throw new Error(`Endpoint is disabled: ${widget.dataSource.endpointName}`);
    }

    return executeEndpointQuery(endpoint.sql_query, widget.dataSource.params || {});
  } else if (widget.dataSource.type === 'inline') {
    // Execute inline SQL
    if (!widget.dataSource.sql) {
      throw new Error('SQL is required for inline data source');
    }

    // Security: Only allow SELECT statements
    const trimmed = widget.dataSource.sql.trim().toLowerCase();
    if (!trimmed.startsWith('select')) {
      throw new Error('Only SELECT statements are allowed');
    }

    // Apply parameter interpolation
    let interpolatedSql = widget.dataSource.sql;
    if (widget.dataSource.params) {
      for (const [key, value] of Object.entries(widget.dataSource.params)) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
        const placeholder = new RegExp(`@${key}\\b`, 'g');
        interpolatedSql = interpolatedSql.replace(placeholder, `'${escapeString(value)}'`);
      }
    }

    return queryClickHouse<unknown>(interpolatedSql);
  } else {
    throw new Error(`Unknown data source type: ${widget.dataSource.type}`);
  }
}

// Alerts

export interface Alert {
  id: string;
  name: string;
  description: string;
  query: string;
  condition: string;
  interval_seconds: number;
  cooldown_seconds: number;
  recipients: string;  // JSON array string
  destination_ids: string;  // JSON array string
  subject: string;
  enabled: number;
  created_at: string;
  last_triggered_at: string;
}

export interface AlertInput {
  name: string;
  description?: string;
  query: string;
  condition: string;
  interval_seconds?: number;
  cooldown_seconds?: number;
  recipients?: string[];
  destination_ids?: string[];
  subject: string;
}

export async function getAlerts(): Promise<Alert[]> {
  const sql = `
    SELECT
      toString(id) as id,
      name,
      description,
      query,
      condition,
      interval_seconds,
      cooldown_seconds,
      recipients,
      destination_ids,
      subject,
      enabled,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at,
      formatDateTime(last_triggered_at, '%Y-%m-%d %H:%i:%S') as last_triggered_at
    FROM logs.alerts
    ORDER BY created_at DESC
  `;

  return queryClickHouse<Alert>(sql);
}

export async function getAlertById(id: string): Promise<Alert | null> {
  const sql = `
    SELECT
      toString(id) as id,
      name,
      description,
      query,
      condition,
      interval_seconds,
      cooldown_seconds,
      recipients,
      destination_ids,
      subject,
      enabled,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at,
      formatDateTime(last_triggered_at, '%Y-%m-%d %H:%i:%S') as last_triggered_at
    FROM logs.alerts
    WHERE id = '${escapeString(id)}'
    LIMIT 1
  `;

  const results = await queryClickHouse<Alert>(sql);
  return results.length > 0 ? results[0] : null;
}

export async function createAlert(alert: AlertInput): Promise<void> {
  const recipientsJson = JSON.stringify(alert.recipients || []);
  const destinationIdsJson = JSON.stringify(alert.destination_ids || []);
  const sql = `
    INSERT INTO logs.alerts (name, description, query, condition, interval_seconds, cooldown_seconds, recipients, destination_ids, subject)
    VALUES (
      '${escapeString(alert.name)}',
      '${escapeString(alert.description || '')}',
      '${escapeString(alert.query)}',
      '${escapeString(alert.condition)}',
      ${alert.interval_seconds || 60},
      ${alert.cooldown_seconds || 300},
      '${escapeString(recipientsJson)}',
      '${escapeString(destinationIdsJson)}',
      '${escapeString(alert.subject)}'
    )
  `;

  await executeClickHouse(sql);
}

export async function updateAlert(id: string, updates: Partial<AlertInput> & { enabled?: number }): Promise<void> {
  const setClauses: string[] = [];

  if (updates.name !== undefined) {
    setClauses.push(`name = '${escapeString(updates.name)}'`);
  }
  if (updates.description !== undefined) {
    setClauses.push(`description = '${escapeString(updates.description)}'`);
  }
  if (updates.query !== undefined) {
    setClauses.push(`query = '${escapeString(updates.query)}'`);
  }
  if (updates.condition !== undefined) {
    setClauses.push(`condition = '${escapeString(updates.condition)}'`);
  }
  if (updates.interval_seconds !== undefined) {
    setClauses.push(`interval_seconds = ${updates.interval_seconds}`);
  }
  if (updates.cooldown_seconds !== undefined) {
    setClauses.push(`cooldown_seconds = ${updates.cooldown_seconds}`);
  }
  if (updates.recipients !== undefined) {
    const recipientsJson = JSON.stringify(updates.recipients);
    setClauses.push(`recipients = '${escapeString(recipientsJson)}'`);
  }
  if (updates.destination_ids !== undefined) {
    const destinationIdsJson = JSON.stringify(updates.destination_ids);
    setClauses.push(`destination_ids = '${escapeString(destinationIdsJson)}'`);
  }
  if (updates.subject !== undefined) {
    setClauses.push(`subject = '${escapeString(updates.subject)}'`);
  }
  if (updates.enabled !== undefined) {
    setClauses.push(`enabled = ${updates.enabled}`);
  }

  if (setClauses.length === 0) return;

  const sql = `
    ALTER TABLE logs.alerts
    UPDATE ${setClauses.join(', ')}
    WHERE id = '${escapeString(id)}'
  `;

  await executeClickHouse(sql);
}

export async function deleteAlert(id: string): Promise<void> {
  const sql = `
    ALTER TABLE logs.alerts
    DELETE WHERE id = '${escapeString(id)}'
  `;

  await executeClickHouse(sql);
}

export async function testAlertQuery(query: string): Promise<Record<string, unknown>[]> {
  // Security: Only allow SELECT statements
  const trimmed = query.trim().toLowerCase();
  if (!trimmed.startsWith('select')) {
    throw new Error('Only SELECT statements are allowed');
  }

  return queryClickHouse<Record<string, unknown>>(query);
}

// Alert Destinations

export interface AlertDestination {
  id: string;
  name: string;
  type: string;
  config: string;
  enabled: number;
  created_at: string;
}

export interface EmailDestinationConfig {
  email: string;
  from?: string;
}

export interface WebhookDestinationConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeout_seconds?: number;
}

export interface AlertDestinationInput {
  name: string;
  type: 'email' | 'webhook';
  config: EmailDestinationConfig | WebhookDestinationConfig;
}

export async function getAlertDestinations(): Promise<AlertDestination[]> {
  const sql = `
    SELECT
      toString(id) as id,
      name,
      type,
      config,
      enabled,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at
    FROM logs.alert_destinations
    ORDER BY created_at DESC
  `;

  return queryClickHouse<AlertDestination>(sql);
}

export async function getAlertDestinationById(id: string): Promise<AlertDestination | null> {
  const sql = `
    SELECT
      toString(id) as id,
      name,
      type,
      config,
      enabled,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at
    FROM logs.alert_destinations
    WHERE id = '${escapeString(id)}'
    LIMIT 1
  `;

  const results = await queryClickHouse<AlertDestination>(sql);
  return results.length > 0 ? results[0] : null;
}

export async function createAlertDestination(dest: AlertDestinationInput): Promise<void> {
  const configJson = JSON.stringify(dest.config);
  const sql = `
    INSERT INTO logs.alert_destinations (name, type, config)
    VALUES (
      '${escapeString(dest.name)}',
      '${escapeString(dest.type)}',
      '${escapeString(configJson)}'
    )
  `;

  await executeClickHouse(sql);
}

export async function updateAlertDestination(
  id: string,
  updates: Partial<AlertDestinationInput> & { enabled?: boolean }
): Promise<void> {
  const setClauses: string[] = [];

  if (updates.name !== undefined) {
    setClauses.push(`name = '${escapeString(updates.name)}'`);
  }
  if (updates.type !== undefined) {
    setClauses.push(`type = '${escapeString(updates.type)}'`);
  }
  if (updates.config !== undefined) {
    setClauses.push(`config = '${escapeString(JSON.stringify(updates.config))}'`);
  }
  if (updates.enabled !== undefined) {
    setClauses.push(`enabled = ${updates.enabled ? 1 : 0}`);
  }

  if (setClauses.length === 0) return;

  await executeClickHouse(`
    ALTER TABLE logs.alert_destinations
    UPDATE ${setClauses.join(', ')}
    WHERE id = '${escapeString(id)}'
  `);
}

export async function deleteAlertDestination(id: string): Promise<void> {
  await executeClickHouse(`
    ALTER TABLE logs.alert_destinations
    DELETE WHERE id = '${escapeString(id)}'
  `);
}

// Landing Page Metrics

export interface CurrentMetrics {
  logs_per_minute: number;
  total_logs_24h: number;
  total_errors_24h: number;
  error_rate_24h: number;
  active_services: number;
  services_with_errors: number;
}

export async function getCurrentMetrics(): Promise<CurrentMetrics> {
  const sql = `
    SELECT
      (SELECT count(*) FROM logs.events WHERE timestamp > now() - INTERVAL 1 MINUTE) as logs_per_minute,
      count(*) as total_logs_24h,
      countIf(level IN ('Error', 'Fatal')) as total_errors_24h,
      if(count(*) > 0, round(countIf(level IN ('Error', 'Fatal')) * 100.0 / count(*), 2), 0) as error_rate_24h,
      uniqExact(source) as active_services,
      uniqExactIf(source, level IN ('Error', 'Fatal')) as services_with_errors
    FROM logs.events
    WHERE timestamp > now() - INTERVAL 24 HOUR
  `;

  const results = await queryClickHouse<CurrentMetrics>(sql);
  return results[0] || {
    logs_per_minute: 0,
    total_logs_24h: 0,
    total_errors_24h: 0,
    error_rate_24h: 0,
    active_services: 0,
    services_with_errors: 0
  };
}

export interface HourTrend {
  current_hour_count: number;
  previous_hour_count: number;
  trend_percent: number;
}

export async function getHourOverHourTrend(): Promise<HourTrend> {
  const sql = `
    SELECT
      countIf(timestamp > now() - INTERVAL 1 HOUR) as current_hour_count,
      countIf(timestamp <= now() - INTERVAL 1 HOUR AND timestamp > now() - INTERVAL 2 HOUR) as previous_hour_count,
      if(
        countIf(timestamp <= now() - INTERVAL 1 HOUR AND timestamp > now() - INTERVAL 2 HOUR) > 0,
        round(
          (countIf(timestamp > now() - INTERVAL 1 HOUR) - countIf(timestamp <= now() - INTERVAL 1 HOUR AND timestamp > now() - INTERVAL 2 HOUR))
          * 100.0 / countIf(timestamp <= now() - INTERVAL 1 HOUR AND timestamp > now() - INTERVAL 2 HOUR),
          1
        ),
        0
      ) as trend_percent
    FROM logs.events
    WHERE timestamp > now() - INTERVAL 2 HOUR
  `;

  const results = await queryClickHouse<HourTrend>(sql);
  return results[0] || {
    current_hour_count: 0,
    previous_hour_count: 0,
    trend_percent: 0
  };
}

export interface ErrorRatePoint {
  minute: string;
  error_rate: number;
}

export async function getErrorRateTimeSeries(minutes: number = 60): Promise<ErrorRatePoint[]> {
  const sql = `
    SELECT
      formatDateTime(toStartOfMinute(timestamp), '%Y-%m-%d %H:%i:%S') as minute,
      if(count(*) > 0, round(countIf(level IN ('Error', 'Fatal')) * 100.0 / count(*), 2), 0) as error_rate
    FROM logs.events
    WHERE timestamp > now() - INTERVAL ${minutes} MINUTE
    GROUP BY toStartOfMinute(timestamp)
    ORDER BY toStartOfMinute(timestamp)
  `;

  return queryClickHouse<ErrorRatePoint>(sql);
}

export interface FiringAlert {
  id: string;
  name: string;
  description: string;
  last_triggered_at: string;
  minutes_ago: number;
}

export async function getFiringAlerts(): Promise<FiringAlert[]> {
  // An alert is considered "firing" if it was triggered within its cooldown period
  // This avoids re-evaluating all alert queries on every page load
  const sql = `
    SELECT
      toString(a.id) as id,
      a.name,
      a.description,
      formatDateTime(a.last_triggered_at, '%Y-%m-%d %H:%i:%S') as last_triggered_at,
      toInt32(dateDiff('minute', a.last_triggered_at, now())) as minutes_ago
    FROM logs.alerts a
    WHERE a.enabled = 1
      AND a.last_triggered_at > toDateTime('1970-01-02 00:00:00')
      AND a.last_triggered_at > now() - toIntervalSecond(a.cooldown_seconds)
    ORDER BY a.last_triggered_at DESC
  `;

  return queryClickHouse<FiringAlert>(sql);
}

export type AlertStatus = 'firing' | 'recent' | 'ok';

export interface AlertWithStatus {
  id: string;
  name: string;
  description: string;
  enabled: number;
  last_triggered_at: string;
  cooldown_seconds: number;
  status: AlertStatus;
  minutes_ago: number | null;
}

export async function getAlertsWithStatus(): Promise<AlertWithStatus[]> {
  // Get all enabled alerts with their trigger status
  // Status: 'firing' = triggered within cooldown, 'recent' = triggered in last 24h, 'ok' = not triggered recently
  // Use subquery to compute status before formatting timestamp (avoid alias shadowing)
  const sql = `
    SELECT
      id,
      name,
      description,
      enabled,
      formatDateTime(triggered_at, '%Y-%m-%d %H:%i:%S') as last_triggered_at,
      cooldown_seconds,
      status,
      minutes_ago
    FROM (
      SELECT
        toString(id) as id,
        name,
        description,
        enabled,
        last_triggered_at as triggered_at,
        cooldown_seconds,
        multiIf(
          last_triggered_at > now() - toIntervalSecond(cooldown_seconds)
            AND last_triggered_at > toDateTime('1970-01-02 00:00:00'),
          'firing',
          last_triggered_at > now() - INTERVAL 24 HOUR
            AND last_triggered_at > toDateTime('1970-01-02 00:00:00'),
          'recent',
          'ok'
        ) as status,
        if(last_triggered_at > toDateTime('1970-01-02 00:00:00'),
           toInt32(dateDiff('minute', last_triggered_at, now())),
           NULL) as minutes_ago
      FROM logs.alerts
      WHERE enabled = 1
    )
    ORDER BY
      multiIf(status = 'firing', 1, status = 'recent', 2, 3),
      triggered_at DESC
  `;

  return queryClickHouse<AlertWithStatus>(sql);
}

export interface TopService {
  source: string;
  total_count: number;
  error_count: number;
  error_rate: number;
  last_log: string;
}

export async function getTopServicesByErrors(limit: number = 5): Promise<TopService[]> {
  const sql = `
    SELECT
      source,
      count(*) as total_count,
      countIf(level IN ('Error', 'Fatal')) as error_count,
      if(count(*) > 0, round(countIf(level IN ('Error', 'Fatal')) * 100.0 / count(*), 2), 0) as error_rate,
      formatDateTime(max(timestamp), '%Y-%m-%d %H:%i:%S') as last_log
    FROM logs.events
    WHERE timestamp > now() - INTERVAL 24 HOUR
    GROUP BY source
    ORDER BY error_count DESC
    LIMIT ${limit}
  `;

  return queryClickHouse<TopService>(sql);
}

// Count logs by filters
export async function countLogs(
  source?: string,
  level?: string,
  search?: string,
  propertyFilters?: PropertyFilter[]
): Promise<number> {
  const conditions: string[] = [];

  if (source) {
    conditions.push(`source = '${escapeString(source)}'`);
  }

  if (level) {
    conditions.push(`level = '${escapeString(level)}'`);
  }

  if (search) {
    conditions.push(`message LIKE '%${escapeString(search)}%'`);
  }

  if (propertyFilters && propertyFilters.length > 0) {
    for (const filter of propertyFilters) {
      const isNumeric = isNumericValue(filter.value);
      const jsonExtract = buildJsonExtractSql('properties', filter.key, isNumeric ? 'number' : 'string');
      const escapedValue = escapeString(filter.value);

      if (isNumeric) {
        conditions.push(`${jsonExtract} ${filter.operator} ${escapedValue}`);
      } else {
        const op = filter.operator === '!=' ? '!=' : '=';
        conditions.push(`${jsonExtract} ${op} '${escapedValue}'`);
      }
    }
  }

  if (conditions.length === 0) {
    throw new Error('At least one filter is required to count logs');
  }

  const countSql = `SELECT count(*) as count FROM logs.events WHERE ${conditions.join(' AND ')}`;
  const countResult = await queryClickHouse<{ count: number }>(countSql);
  return countResult[0]?.count || 0;
}

// System Observability Metrics

export interface SystemMetrics {
  total_logs: number;
  total_logs_24h: number;
  oldest_log: string | null;
  newest_log: string | null;
  table_size_bytes: number;
  table_size_formatted: string;
  rows_per_partition: { partition: string; rows: number; size_bytes: number }[];
  disk_total_bytes: number;
  disk_free_bytes: number;
  disk_used_bytes: number;
  disk_used_percent: number;
  active_parts: number;
  tables: { table: string; rows: number; size_bytes: number }[];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export async function getSystemMetrics(): Promise<SystemMetrics> {
  // Run all queries in parallel
  const [
    totalLogsResult,
    logs24hResult,
    timeRangeResult,
    tableSizeResult,
    partitionsResult,
    diskResult,
    partsCountResult,
    tablesResult
  ] = await Promise.all([
    // Total log count
    queryClickHouse<{ count: number }>(`SELECT count(*) as count FROM logs.events`),

    // Logs in last 24h
    queryClickHouse<{ count: number }>(`
      SELECT count(*) as count FROM logs.events
      WHERE timestamp > now() - INTERVAL 24 HOUR
    `),

    // Oldest and newest log timestamps.
    // Filter implausible timestamps (epoch-zero rows from misconfigured clients
    // poison min(); far-future rows would poison max()) so the displayed range
    // reflects real log activity, not bogus payloads.
    queryClickHouse<{ oldest: string; newest: string }>(`
      SELECT
        formatDateTime(min(timestamp), '%Y-%m-%d %H:%i:%S') as oldest,
        formatDateTime(max(timestamp), '%Y-%m-%d %H:%i:%S') as newest
      FROM logs.events
      WHERE timestamp > toDateTime('2000-01-01 00:00:00')
        AND timestamp < toDateTime('2100-01-01 00:00:00')
    `),

    // Table size from system.parts
    queryClickHouse<{ size_bytes: number }>(`
      SELECT sum(bytes) as size_bytes
      FROM system.parts
      WHERE database = 'logs' AND table = 'events' AND active = 1
    `),

    // Rows and size per partition (one row per daily partition).
    queryClickHouse<{ partition: string; rows: number; size_bytes: number }>(`
      SELECT
        partition,
        sum(rows) as rows,
        sum(bytes) as size_bytes
      FROM system.parts
      WHERE database = 'logs' AND table = 'events' AND active = 1
      GROUP BY partition
      ORDER BY partition DESC
    `),

    // Disk usage
    queryClickHouse<{ total: number; free: number }>(`
      SELECT
        total_space as total,
        free_space as free
      FROM system.disks
      WHERE name = 'default'
    `),

    // Active parts count
    queryClickHouse<{ count: number }>(`
      SELECT count() as count
      FROM system.parts
      WHERE database = 'logs' AND table = 'events' AND active = 1
    `),

    // All tables in logs database with sizes
    queryClickHouse<{ table: string; rows: number; size_bytes: number }>(`
      SELECT
        table,
        sum(rows) as rows,
        sum(bytes) as size_bytes
      FROM system.parts
      WHERE database = 'logs' AND active = 1
      GROUP BY table
      ORDER BY size_bytes DESC
    `)
  ]);

  const totalLogs = totalLogsResult[0]?.count || 0;
  const logs24h = logs24hResult[0]?.count || 0;
  const timeRange = timeRangeResult[0] || { oldest: null, newest: null };
  const tableSizeBytes = tableSizeResult[0]?.size_bytes || 0;
  const diskInfo = diskResult[0] || { total: 0, free: 0 };
  const activeParts = partsCountResult[0]?.count || 0;

  const diskUsedBytes = diskInfo.total - diskInfo.free;
  const diskUsedPercent = diskInfo.total > 0
    ? Math.round((diskUsedBytes / diskInfo.total) * 100 * 10) / 10
    : 0;

  return {
    total_logs: totalLogs,
    total_logs_24h: logs24h,
    oldest_log: timeRange.oldest || null,
    newest_log: timeRange.newest || null,
    table_size_bytes: tableSizeBytes,
    table_size_formatted: formatBytes(tableSizeBytes),
    rows_per_partition: partitionsResult,
    disk_total_bytes: diskInfo.total,
    disk_free_bytes: diskInfo.free,
    disk_used_bytes: diskUsedBytes,
    disk_used_percent: diskUsedPercent,
    active_parts: activeParts,
    tables: tablesResult
  };
}

// Delete logs by filters
export async function deleteLogs(
  source?: string,
  level?: string,
  search?: string,
  propertyFilters?: PropertyFilter[]
): Promise<number> {
  const conditions: string[] = [];

  if (source) {
    conditions.push(`source = '${escapeString(source)}'`);
  }

  if (level) {
    conditions.push(`level = '${escapeString(level)}'`);
  }

  if (search) {
    conditions.push(`message LIKE '%${escapeString(search)}%'`);
  }

  if (propertyFilters && propertyFilters.length > 0) {
    for (const filter of propertyFilters) {
      const isNumeric = isNumericValue(filter.value);
      const jsonExtract = buildJsonExtractSql('properties', filter.key, isNumeric ? 'number' : 'string');
      const escapedValue = escapeString(filter.value);

      if (isNumeric) {
        conditions.push(`${jsonExtract} ${filter.operator} ${escapedValue}`);
      } else {
        const op = filter.operator === '!=' ? '!=' : '=';
        conditions.push(`${jsonExtract} ${op} '${escapedValue}'`);
      }
    }
  }

  if (conditions.length === 0) {
    throw new Error('At least one filter is required to delete logs');
  }

  // First count how many will be deleted
  const countSql = `SELECT count(*) as count FROM logs.events WHERE ${conditions.join(' AND ')}`;
  const countResult = await queryClickHouse<{ count: number }>(countSql);
  const count = countResult[0]?.count || 0;

  if (count === 0) {
    return 0;
  }

  // Delete the logs
  const deleteSql = `ALTER TABLE logs.events DELETE WHERE ${conditions.join(' AND ')}`;
  await executeClickHouse(deleteSql);

  return count;
}

// MCP investigation helpers

export interface ErrorSummaryRow {
  message_template: string;
  level: string;
  count: number;
  latest_timestamp: string;
  sample_message: string;
}

export async function getErrorSummary(
  source?: string,
  hours: number = 24,
  limit: number = 20
): Promise<ErrorSummaryRow[]> {
  const conditions = [
    `level IN ('Error', 'Fatal', 'Warning')`,
    `timestamp > now() - INTERVAL ${Math.max(1, Math.min(hours, 168))} HOUR`,
  ];
  if (source) {
    conditions.push(`source = '${escapeString(source)}'`);
  }

  const sql = `
    SELECT
      message_template,
      level,
      count(*) as count,
      formatDateTime(max(timestamp), '%Y-%m-%d %H:%i:%S') as latest_timestamp,
      any(message) as sample_message
    FROM logs.events
    WHERE ${conditions.join(' AND ')}
    GROUP BY message_template, level
    ORDER BY count DESC
    LIMIT ${Math.min(limit, 100)}
  `;

  return queryClickHouse<ErrorSummaryRow>(sql);
}

export interface LogVolumeRow {
  bucket: string;
  total: number;
  errors: number;
  warnings: number;
  info: number;
}

export async function getLogVolume(
  source?: string,
  hours: number = 24,
  granularity: 'minute' | 'hour' | 'day' = 'hour'
): Promise<LogVolumeRow[]> {
  const truncFn = granularity === 'minute' ? 'toStartOfMinute' :
                  granularity === 'day' ? 'toStartOfDay' : 'toStartOfHour';
  const safeHours = Math.max(1, Math.min(hours, 168));

  const conditions = [
    `timestamp > now() - INTERVAL ${safeHours} HOUR`,
  ];
  if (source) {
    conditions.push(`source = '${escapeString(source)}'`);
  }

  const sql = `
    SELECT
      formatDateTime(${truncFn}(timestamp), '%Y-%m-%d %H:%i:%S') as bucket,
      count(*) as total,
      countIf(level IN ('Error', 'Fatal')) as errors,
      countIf(level = 'Warning') as warnings,
      countIf(level = 'Information') as info
    FROM logs.events
    WHERE ${conditions.join(' AND ')}
    GROUP BY ${truncFn}(timestamp)
    ORDER BY ${truncFn}(timestamp)
  `;

  return queryClickHouse<LogVolumeRow>(sql);
}

// ── Log Ingestion ─────────────────────────────────────────────

export async function insertLogEvent(params: {
  level: string;
  message: string;
  message_template?: string;
  source: string;
  exception?: string;
  event_type?: string;
  properties?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').replace('Z', '');

  const row = {
    timestamp: ts,
    level: params.level,
    message_template: params.message_template || params.message,
    message: params.message,
    exception: params.exception || '',
    event_type: params.event_type || '',
    source: params.source,
    properties: params.properties ? JSON.stringify(params.properties) : '{}',
  };

  const response = await fetch(
    `${CLICKHOUSE_URL}/?query=${encodeURIComponent('INSERT INTO logs.events FORMAT JSONEachRow')}`,
    {
      method: 'POST',
      body: JSON.stringify(row),
      headers: { 'Content-Type': 'application/json' },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickHouse insert failed: ${errorText}`);
  }
}
