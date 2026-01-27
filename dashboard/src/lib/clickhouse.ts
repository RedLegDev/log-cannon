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

export interface APIKey {
  key_id: string;
  api_key: string;
  name: string;
  scopes: string;
  created_at: string;
  enabled: number;
}

export async function getAPIKeys(): Promise<APIKey[]> {
  const sql = `
    SELECT
      toString(key_id) as key_id,
      api_key,
      name,
      scopes,
      formatDateTime(created_at, '%Y-%m-%d %H:%i:%S') as created_at,
      enabled
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
      enabled
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

export async function renameAPIKey(keyId: string, name: string): Promise<void> {
  // Get current key to find the old name
  const currentKey = await getAPIKey(keyId);
  if (!currentKey) {
    throw new Error(`API key not found: ${keyId}`);
  }

  const oldName = currentKey.name;

  // Update the API key name
  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: `
      ALTER TABLE logs.api_keys
      UPDATE name = '${escapeString(name)}'
      WHERE key_id = '${escapeString(keyId)}'
    `,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });

  // Update all events with the old source name to use the new name
  await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: `
      ALTER TABLE logs.events
      UPDATE source = '${escapeString(name)}'
      WHERE source = '${escapeString(oldName)}'
    `,
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
