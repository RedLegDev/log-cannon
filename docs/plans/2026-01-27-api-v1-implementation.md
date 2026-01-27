# API v1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a REST API at `/api/v1/` with API key authentication for programmatic access to Log Cannon resources.

**Architecture:** New Next.js API routes under `/api/v1/` with shared auth middleware. Reuses existing `lib/clickhouse.ts` functions. API keys gain a `scopes` column for permission control.

**Tech Stack:** Next.js 14 API routes, TypeScript, ClickHouse

---

## Task 1: Add scopes column to api_keys table

**Files:**
- Create: `clickhouse/init/005_api_key_scopes.sql`

**Step 1: Create the migration file**

```sql
-- Add scopes column to api_keys table
-- Default to 'ingest' for backward compatibility with existing keys
ALTER TABLE logs.api_keys ADD COLUMN IF NOT EXISTS scopes String DEFAULT 'ingest';
```

**Step 2: Verify the migration locally**

Run: `docker exec -it log-cannon-clickhouse clickhouse-client --query "ALTER TABLE logs.api_keys ADD COLUMN IF NOT EXISTS scopes String DEFAULT 'ingest'"`

Expected: No output (success)

**Step 3: Verify column exists**

Run: `docker exec -it log-cannon-clickhouse clickhouse-client --query "DESCRIBE logs.api_keys"`

Expected: Output includes `scopes` column with type `String`

**Step 4: Commit**

```bash
git add clickhouse/init/005_api_key_scopes.sql
git commit -m "feat: add scopes column to api_keys for permission control"
```

---

## Task 2: Create API key auth utility

**Files:**
- Create: `dashboard/src/lib/api-auth.ts`

**Step 1: Create the auth utility**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { queryClickHouse } from './clickhouse';

export type ApiScope = 'ingest' | 'read' | 'write' | 'admin';

interface ApiKeyRecord {
  key_id: string;
  api_key: string;
  name: string;
  scopes: string;
  enabled: number;
}

export interface AuthenticatedRequest {
  keyId: string;
  keyName: string;
  scopes: ApiScope[];
}

// Scope hierarchy: admin > write > read > ingest
const SCOPE_HIERARCHY: Record<ApiScope, ApiScope[]> = {
  admin: ['admin', 'write', 'read', 'ingest'],
  write: ['write', 'read', 'ingest'],
  read: ['read', 'ingest'],
  ingest: ['ingest'],
};

function parseScopes(scopesStr: string): ApiScope[] {
  if (!scopesStr) return ['ingest'];
  return scopesStr.split(',').map(s => s.trim()) as ApiScope[];
}

function hasScope(keyScopes: ApiScope[], requiredScope: ApiScope): boolean {
  for (const scope of keyScopes) {
    if (SCOPE_HIERARCHY[scope]?.includes(requiredScope)) {
      return true;
    }
  }
  return false;
}

export function apiError(
  error: string,
  message: string,
  status: number,
  details?: Record<string, unknown>
): NextResponse {
  return NextResponse.json(
    { error, message, ...(details && { details }) },
    { status }
  );
}

export async function authenticateApiKey(
  request: NextRequest,
  requiredScope: ApiScope
): Promise<AuthenticatedRequest | NextResponse> {
  // Extract API key from headers
  const apiKey =
    request.headers.get('x-api-key') ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');

  if (!apiKey) {
    return apiError('unauthorized', 'Missing API key. Provide X-Api-Key header or Authorization: Bearer <key>', 401);
  }

  // Look up the key
  const sql = `
    SELECT
      toString(key_id) as key_id,
      api_key,
      name,
      scopes,
      enabled
    FROM logs.api_keys
    WHERE api_key = '${apiKey.replace(/'/g, "''")}'
    LIMIT 1
  `;

  try {
    const results = await queryClickHouse<ApiKeyRecord>(sql);

    if (results.length === 0) {
      return apiError('unauthorized', 'Invalid API key', 401);
    }

    const key = results[0];

    if (!key.enabled) {
      return apiError('unauthorized', 'API key is disabled', 401);
    }

    const scopes = parseScopes(key.scopes);

    if (!hasScope(scopes, requiredScope)) {
      return apiError('forbidden', `API key lacks required scope: ${requiredScope}`, 403);
    }

    return {
      keyId: key.key_id,
      keyName: key.name,
      scopes,
    };
  } catch (error) {
    console.error('API key authentication error:', error);
    return apiError('internal_error', 'Authentication failed', 500);
  }
}

// Helper for route handlers
export function withApiAuth(requiredScope: ApiScope) {
  return async function authenticate(request: NextRequest): Promise<AuthenticatedRequest | NextResponse> {
    return authenticateApiKey(request, requiredScope);
  };
}
```

**Step 2: Commit**

```bash
git add dashboard/src/lib/api-auth.ts
git commit -m "feat: add API key authentication utility with scope checking"
```

---

## Task 3: Create logs endpoint

**Files:**
- Create: `dashboard/src/app/api/v1/logs/route.ts`

**Step 1: Create the logs route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getRecentLogs, parseOperatorFromValue, PropertyFilter } from '@/lib/clickhouse';

export async function GET(request: NextRequest) {
  // Authenticate
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(request.url);

    // Parse query parameters
    const source = searchParams.get('source') || undefined;
    const level = searchParams.get('level') || undefined;
    const search = searchParams.get('search') || undefined;
    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 1000);

    // Parse property filters (prop.key=value or prop.key=>value)
    const propertyFilters: PropertyFilter[] = [];
    for (const [key, value] of searchParams.entries()) {
      if (key.startsWith('prop.')) {
        const propKey = key.slice(5); // Remove 'prop.' prefix
        const { operator, value: parsedValue } = parseOperatorFromValue(value);
        propertyFilters.push({ key: propKey, value: parsedValue, operator });
      }
    }

    const logs = await getRecentLogs(source, level, search, propertyFilters, limit);

    // Transform to API format
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

    return NextResponse.json({
      data,
      meta: { count: data.length, limit },
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    return apiError('internal_error', 'Failed to fetch logs', 500);
  }
}
```

**Step 2: Commit**

```bash
git add dashboard/src/app/api/v1/logs/route.ts
git commit -m "feat: add GET /api/v1/logs endpoint with filtering"
```

---

## Task 4: Create query endpoint

**Files:**
- Create: `dashboard/src/app/api/v1/query/route.ts`

**Step 1: Create the query route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { queryClickHouse } from '@/lib/clickhouse';

const MAX_ROWS = 10000;
const QUERY_TIMEOUT_MS = 30000;

export async function POST(request: NextRequest) {
  // Authenticate
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const { sql } = body;

    if (!sql || typeof sql !== 'string') {
      return apiError('validation_error', 'SQL query is required', 400, {
        fields: { sql: 'Required field' },
      });
    }

    // Security: Only allow SELECT statements
    const trimmed = sql.trim().toLowerCase();
    if (!trimmed.startsWith('select')) {
      return apiError('query_error', 'Only SELECT statements are allowed', 400);
    }

    // Add LIMIT if not present to prevent massive result sets
    const hasLimit = /\blimit\s+\d+/i.test(sql);
    const limitedSql = hasLimit ? sql : `${sql} LIMIT ${MAX_ROWS}`;

    const startTime = Date.now();

    // Execute with timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Query timeout')), QUERY_TIMEOUT_MS);
    });

    const queryPromise = queryClickHouse<unknown>(limitedSql);
    const data = await Promise.race([queryPromise, timeoutPromise]);

    const elapsedMs = Date.now() - startTime;

    return NextResponse.json({
      data,
      meta: {
        rows: Array.isArray(data) ? data.length : 0,
        elapsed_ms: elapsedMs,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Query failed';

    if (message === 'Query timeout') {
      return apiError('query_timeout', 'Query exceeded 30 second timeout', 408);
    }

    // Check if it's a ClickHouse syntax error
    if (message.includes('ClickHouse query failed')) {
      return apiError('query_error', message, 400);
    }

    console.error('Query error:', error);
    return apiError('internal_error', 'Query execution failed', 500);
  }
}
```

**Step 2: Commit**

```bash
git add dashboard/src/app/api/v1/query/route.ts
git commit -m "feat: add POST /api/v1/query endpoint for arbitrary SELECT queries"
```

---

## Task 5: Create dashboards v1 endpoints

**Files:**
- Create: `dashboard/src/app/api/v1/dashboards/route.ts`
- Create: `dashboard/src/app/api/v1/dashboards/[name]/route.ts`

**Step 1: Create the dashboards list/create route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getDashboards, createDashboard, DashboardConfig } from '@/lib/clickhouse';

function validateDashboardInput(body: unknown): { valid: true; data: { name: string; description?: string; config: DashboardConfig } } | { valid: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: { body: 'Request body is required' } };
  }

  const { name, description, config } = body as Record<string, unknown>;

  if (!name || typeof name !== 'string') {
    errors.name = 'Required field';
  } else if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    errors.name = 'Must be URL-safe (letters, numbers, dashes, underscores)';
  }

  if (description !== undefined && typeof description !== 'string') {
    errors.description = 'Must be a string';
  }

  if (!config || typeof config !== 'object') {
    errors.config = 'Required field';
  } else {
    const cfg = config as Record<string, unknown>;
    if (!cfg.layout || !['auto', 'grid'].includes(cfg.layout as string)) {
      errors['config.layout'] = 'Must be "auto" or "grid"';
    }
    if (!Array.isArray(cfg.widgets) || cfg.widgets.length === 0) {
      errors['config.widgets'] = 'Must have at least one widget';
    }
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      name: name as string,
      description: description as string | undefined,
      config: config as DashboardConfig,
    },
  };
}

export async function GET(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const dashboards = await getDashboards();

    const data = dashboards.map(d => ({
      id: d.id,
      name: d.name,
      description: d.description,
      config: JSON.parse(d.config),
      enabled: Boolean(d.enabled),
      created_at: d.created_at,
      updated_at: d.updated_at,
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Error fetching dashboards:', error);
    return apiError('internal_error', 'Failed to fetch dashboards', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const validation = validateDashboardInput(body);

    if (!validation.valid) {
      return apiError('validation_error', 'Invalid request', 400, { fields: validation.errors });
    }

    await createDashboard(validation.data);

    return NextResponse.json({ success: true, name: validation.data.name }, { status: 201 });
  } catch (error) {
    console.error('Error creating dashboard:', error);
    return apiError('internal_error', 'Failed to create dashboard', 500);
  }
}
```

**Step 2: Create the single dashboard route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getDashboardByName, updateDashboard, deleteDashboard, getDashboards } from '@/lib/clickhouse';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const { name } = await params;
    const dashboard = await getDashboardByName(name);

    if (!dashboard) {
      return apiError('not_found', `Dashboard not found: ${name}`, 404);
    }

    return NextResponse.json({
      id: dashboard.id,
      name: dashboard.name,
      description: dashboard.description,
      config: JSON.parse(dashboard.config),
      enabled: Boolean(dashboard.enabled),
      created_at: dashboard.created_at,
      updated_at: dashboard.updated_at,
    });
  } catch (error) {
    console.error('Error fetching dashboard:', error);
    return apiError('internal_error', 'Failed to fetch dashboard', 500);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const { name } = await params;
    const dashboard = await getDashboardByName(name);

    if (!dashboard) {
      return apiError('not_found', `Dashboard not found: ${name}`, 404);
    }

    const body = await request.json();
    const updates: Record<string, unknown> = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.config !== undefined) updates.config = body.config;
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    if (Object.keys(updates).length === 0) {
      return apiError('validation_error', 'No valid fields to update', 400);
    }

    await updateDashboard(dashboard.id, updates);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating dashboard:', error);
    return apiError('internal_error', 'Failed to update dashboard', 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const { name } = await params;
    const dashboard = await getDashboardByName(name);

    if (!dashboard) {
      return apiError('not_found', `Dashboard not found: ${name}`, 404);
    }

    await deleteDashboard(dashboard.id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting dashboard:', error);
    return apiError('internal_error', 'Failed to delete dashboard', 500);
  }
}
```

**Step 3: Commit**

```bash
git add dashboard/src/app/api/v1/dashboards/
git commit -m "feat: add CRUD endpoints for /api/v1/dashboards"
```

---

## Task 6: Create endpoints v1 routes

**Files:**
- Create: `dashboard/src/app/api/v1/endpoints/route.ts`
- Create: `dashboard/src/app/api/v1/endpoints/[name]/route.ts`

**Step 1: Create the endpoints list/create route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getEndpoints, createEndpoint } from '@/lib/clickhouse';

function validateEndpointInput(body: unknown): { valid: true; data: { name: string; description?: string; sql_query: string; cache_ttl_seconds?: number } } | { valid: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: { body: 'Request body is required' } };
  }

  const { name, description, sql_query, cache_ttl_seconds } = body as Record<string, unknown>;

  if (!name || typeof name !== 'string') {
    errors.name = 'Required field';
  } else if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    errors.name = 'Must be URL-safe (letters, numbers, dashes, underscores)';
  }

  if (description !== undefined && typeof description !== 'string') {
    errors.description = 'Must be a string';
  }

  if (!sql_query || typeof sql_query !== 'string') {
    errors.sql_query = 'Required field';
  } else {
    const trimmed = sql_query.trim().toLowerCase();
    if (!trimmed.startsWith('select')) {
      errors.sql_query = 'Must be a SELECT statement';
    }
  }

  if (cache_ttl_seconds !== undefined && (typeof cache_ttl_seconds !== 'number' || cache_ttl_seconds < 0)) {
    errors.cache_ttl_seconds = 'Must be a non-negative number';
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      name: name as string,
      description: description as string | undefined,
      sql_query: sql_query as string,
      cache_ttl_seconds: cache_ttl_seconds as number | undefined,
    },
  };
}

// Extract @param placeholders from SQL
function extractParameters(sql: string): string[] {
  const matches = sql.match(/@[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
  return [...new Set(matches.map(m => m.slice(1)))];
}

export async function GET(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const endpoints = await getEndpoints();

    const data = endpoints.map(e => ({
      id: e.id,
      name: e.name,
      description: e.description,
      sql_query: e.sql_query,
      parameters: extractParameters(e.sql_query),
      cache_ttl_seconds: e.cache_ttl_seconds,
      enabled: Boolean(e.enabled),
      created_at: e.created_at,
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Error fetching endpoints:', error);
    return apiError('internal_error', 'Failed to fetch endpoints', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const validation = validateEndpointInput(body);

    if (!validation.valid) {
      return apiError('validation_error', 'Invalid request', 400, { fields: validation.errors });
    }

    await createEndpoint(validation.data);

    return NextResponse.json({
      success: true,
      name: validation.data.name,
      parameters: extractParameters(validation.data.sql_query),
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating endpoint:', error);
    return apiError('internal_error', 'Failed to create endpoint', 500);
  }
}
```

**Step 2: Create the single endpoint route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getEndpointByName, updateEndpoint, deleteEndpoint, executeEndpointQuery } from '@/lib/clickhouse';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const { name } = await params;
    const endpoint = await getEndpointByName(name);

    if (!endpoint) {
      return apiError('not_found', `Endpoint not found: ${name}`, 404);
    }

    if (!endpoint.enabled) {
      return apiError('forbidden', `Endpoint is disabled: ${name}`, 403);
    }

    // Extract query parameters for execution
    const { searchParams } = new URL(request.url);
    const queryParams: Record<string, string> = {};
    for (const [key, value] of searchParams.entries()) {
      queryParams[key] = value;
    }

    const data = await executeEndpointQuery(endpoint.sql_query, queryParams);

    return NextResponse.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Execution failed';
    console.error('Error executing endpoint:', error);

    if (message.includes('ClickHouse query failed')) {
      return apiError('query_error', message, 400);
    }

    return apiError('internal_error', 'Failed to execute endpoint', 500);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const { name } = await params;
    const endpoint = await getEndpointByName(name);

    if (!endpoint) {
      return apiError('not_found', `Endpoint not found: ${name}`, 404);
    }

    const body = await request.json();
    const updates: Record<string, unknown> = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.sql_query !== undefined) {
      const trimmed = body.sql_query.trim().toLowerCase();
      if (!trimmed.startsWith('select')) {
        return apiError('validation_error', 'sql_query must be a SELECT statement', 400);
      }
      updates.sql_query = body.sql_query;
    }
    if (body.cache_ttl_seconds !== undefined) updates.cache_ttl_seconds = body.cache_ttl_seconds;
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    if (Object.keys(updates).length === 0) {
      return apiError('validation_error', 'No valid fields to update', 400);
    }

    await updateEndpoint(endpoint.id, updates);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating endpoint:', error);
    return apiError('internal_error', 'Failed to update endpoint', 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const { name } = await params;
    const endpoint = await getEndpointByName(name);

    if (!endpoint) {
      return apiError('not_found', `Endpoint not found: ${name}`, 404);
    }

    await deleteEndpoint(endpoint.id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting endpoint:', error);
    return apiError('internal_error', 'Failed to delete endpoint', 500);
  }
}
```

**Step 3: Commit**

```bash
git add dashboard/src/app/api/v1/endpoints/
git commit -m "feat: add CRUD + execute endpoints for /api/v1/endpoints"
```

---

## Task 7: Create saved-queries v1 routes

**Files:**
- Create: `dashboard/src/app/api/v1/saved-queries/route.ts`
- Create: `dashboard/src/app/api/v1/saved-queries/[id]/route.ts`

**Step 1: Create the saved-queries list/create route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getSavedQueries, createSavedQuery, PropertyFilter } from '@/lib/clickhouse';

interface SavedQueryInput {
  name: string;
  description?: string;
  filters: {
    source?: string;
    level?: string;
    search?: string;
    properties?: Record<string, string>;
  };
}

function validateSavedQueryInput(body: unknown): { valid: true; data: SavedQueryInput } | { valid: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: { body: 'Request body is required' } };
  }

  const { name, description, filters } = body as Record<string, unknown>;

  if (!name || typeof name !== 'string') {
    errors.name = 'Required field';
  }

  if (description !== undefined && typeof description !== 'string') {
    errors.description = 'Must be a string';
  }

  if (!filters || typeof filters !== 'object') {
    errors.filters = 'Required field';
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: body as SavedQueryInput,
  };
}

export async function GET(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const queries = await getSavedQueries();

    const data = queries.map(q => ({
      id: q.id,
      name: q.name,
      description: q.description,
      filters: {
        source: q.source || undefined,
        level: q.level || undefined,
        search: q.search || undefined,
        properties: q.property_filters ? JSON.parse(q.property_filters) : undefined,
      },
      created_at: q.created_at,
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Error fetching saved queries:', error);
    return apiError('internal_error', 'Failed to fetch saved queries', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const validation = validateSavedQueryInput(body);

    if (!validation.valid) {
      return apiError('validation_error', 'Invalid request', 400, { fields: validation.errors });
    }

    const { name, description, filters } = validation.data;

    // Convert properties to PropertyFilter array
    const propertyFilters: PropertyFilter[] = [];
    if (filters.properties) {
      for (const [key, value] of Object.entries(filters.properties)) {
        propertyFilters.push({ key, value, operator: '=' });
      }
    }

    await createSavedQuery({
      name,
      description,
      source: filters.source,
      level: filters.level,
      search: filters.search,
      propertyFilters,
    });

    return NextResponse.json({ success: true, name }, { status: 201 });
  } catch (error) {
    console.error('Error creating saved query:', error);
    return apiError('internal_error', 'Failed to create saved query', 500);
  }
}
```

**Step 2: Create the single saved-query route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { deleteSavedQuery, getSavedQueries } from '@/lib/clickhouse';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;

    // Verify the saved query exists
    const queries = await getSavedQueries();
    const exists = queries.some(q => q.id === id);

    if (!exists) {
      return apiError('not_found', `Saved query not found: ${id}`, 404);
    }

    await deleteSavedQuery(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting saved query:', error);
    return apiError('internal_error', 'Failed to delete saved query', 500);
  }
}
```

**Step 3: Commit**

```bash
git add dashboard/src/app/api/v1/saved-queries/
git commit -m "feat: add CRUD endpoints for /api/v1/saved-queries"
```

---

## Task 8: Create keys v1 routes (admin)

**Files:**
- Create: `dashboard/src/app/api/v1/keys/route.ts`
- Create: `dashboard/src/app/api/v1/keys/[id]/route.ts`

**Step 1: Create the keys list/create route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError, ApiScope } from '@/lib/api-auth';
import { getAPIKeys, createAPIKey, queryClickHouse } from '@/lib/clickhouse';

const VALID_SCOPES: ApiScope[] = ['ingest', 'read', 'write', 'admin'];

function validateKeyInput(body: unknown): { valid: true; data: { name: string; scopes: string } } | { valid: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: { body: 'Request body is required' } };
  }

  const { name, scopes } = body as Record<string, unknown>;

  if (!name || typeof name !== 'string') {
    errors.name = 'Required field';
  }

  let scopesStr = 'read'; // Default scope
  if (scopes !== undefined) {
    if (typeof scopes === 'string') {
      const scopeList = scopes.split(',').map(s => s.trim());
      const invalidScopes = scopeList.filter(s => !VALID_SCOPES.includes(s as ApiScope));
      if (invalidScopes.length > 0) {
        errors.scopes = `Invalid scopes: ${invalidScopes.join(', ')}. Valid: ${VALID_SCOPES.join(', ')}`;
      } else {
        scopesStr = scopeList.join(',');
      }
    } else if (Array.isArray(scopes)) {
      const invalidScopes = scopes.filter(s => !VALID_SCOPES.includes(s as ApiScope));
      if (invalidScopes.length > 0) {
        errors.scopes = `Invalid scopes: ${invalidScopes.join(', ')}. Valid: ${VALID_SCOPES.join(', ')}`;
      } else {
        scopesStr = scopes.join(',');
      }
    } else {
      errors.scopes = 'Must be a string or array of scopes';
    }
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: { name: name as string, scopes: scopesStr },
  };
}

export async function GET(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const keys = await getAPIKeys();

    // Don't expose the actual API key values
    const data = keys.map(k => ({
      id: k.key_id,
      name: k.name,
      // Show only prefix of key for identification
      key_prefix: k.api_key.slice(0, 8) + '...',
      enabled: Boolean(k.enabled),
      created_at: k.created_at,
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    return apiError('internal_error', 'Failed to fetch API keys', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const validation = validateKeyInput(body);

    if (!validation.valid) {
      return apiError('validation_error', 'Invalid request', 400, { fields: validation.errors });
    }

    // Create the key (returns the full key value)
    const apiKey = await createAPIKey(validation.data.name);

    // Update scopes for the newly created key
    const updateSql = `
      ALTER TABLE logs.api_keys
      UPDATE scopes = '${validation.data.scopes}'
      WHERE api_key = '${apiKey.replace(/'/g, "''")}'
    `;
    await queryClickHouse(updateSql);

    // Return the full key (only time it's shown)
    return NextResponse.json({
      success: true,
      api_key: apiKey,
      name: validation.data.name,
      scopes: validation.data.scopes,
      message: 'Store this API key securely. It will not be shown again.',
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating API key:', error);
    return apiError('internal_error', 'Failed to create API key', 500);
  }
}
```

**Step 2: Create the single key route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError, ApiScope } from '@/lib/api-auth';
import { toggleAPIKey, renameAPIKey, deleteAPIKey, getAPIKeys, queryClickHouse } from '@/lib/clickhouse';

const VALID_SCOPES: ApiScope[] = ['ingest', 'read', 'write', 'admin'];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateApiKey(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;

    // Verify the key exists
    const keys = await getAPIKeys();
    const key = keys.find(k => k.key_id === id);

    if (!key) {
      return apiError('not_found', `API key not found: ${id}`, 404);
    }

    const body = await request.json();

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name) {
        return apiError('validation_error', 'name must be a non-empty string', 400);
      }
      await renameAPIKey(id, body.name);
    }

    if (body.enabled !== undefined) {
      await toggleAPIKey(id, Boolean(body.enabled));
    }

    if (body.scopes !== undefined) {
      let scopesStr: string;
      if (typeof body.scopes === 'string') {
        scopesStr = body.scopes;
      } else if (Array.isArray(body.scopes)) {
        scopesStr = body.scopes.join(',');
      } else {
        return apiError('validation_error', 'scopes must be a string or array', 400);
      }

      const scopeList = scopesStr.split(',').map(s => s.trim());
      const invalidScopes = scopeList.filter(s => !VALID_SCOPES.includes(s as ApiScope));
      if (invalidScopes.length > 0) {
        return apiError('validation_error', `Invalid scopes: ${invalidScopes.join(', ')}`, 400);
      }

      const updateSql = `
        ALTER TABLE logs.api_keys
        UPDATE scopes = '${scopesStr}'
        WHERE key_id = '${id.replace(/'/g, "''")}'
      `;
      await queryClickHouse(updateSql);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating API key:', error);
    return apiError('internal_error', 'Failed to update API key', 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateApiKey(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;

    // Verify the key exists
    const keys = await getAPIKeys();
    const exists = keys.some(k => k.key_id === id);

    if (!exists) {
      return apiError('not_found', `API key not found: ${id}`, 404);
    }

    await deleteAPIKey(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting API key:', error);
    return apiError('internal_error', 'Failed to delete API key', 500);
  }
}
```

**Step 3: Commit**

```bash
git add dashboard/src/app/api/v1/keys/
git commit -m "feat: add admin endpoints for /api/v1/keys"
```

---

## Task 9: Update middleware to allow /api/v1 routes

**Files:**
- Modify: `dashboard/src/middleware.ts`

**Step 1: Update middleware to make /api/v1 public**

The `/api/v1/` routes use their own API key auth, so they should bypass Clerk:

```typescript
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/llms.txt',
  '/api/v1/(.*)',  // API v1 uses its own API key auth
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }

  // After auth check passes, clean up Clerk's internal params from URL
  const url = request.nextUrl;
  const clerkParams = ['__clerk_db_jwt', '__clerk_ticket', '__clerk_status'];
  let hasClerkParams = false;

  for (const param of clerkParams) {
    if (url.searchParams.has(param)) {
      url.searchParams.delete(param);
      hasClerkParams = true;
    }
  }

  // Redirect to clean URL (only happens if user is authenticated)
  if (hasClerkParams) {
    return NextResponse.redirect(url);
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
```

**Step 2: Commit**

```bash
git add dashboard/src/middleware.ts
git commit -m "feat: bypass Clerk auth for /api/v1 routes (use API key auth)"
```

---

## Task 10: Update llms.txt with API documentation

**Files:**
- Modify: `dashboard/src/app/llms.txt/route.ts`

**Step 1: Add API v1 documentation section**

Add a new section to the `STATIC_DOCS` constant that documents the API:

```typescript
// Add this after the existing STATIC_DOCS content, before the closing backtick:

## API v1 - Programmatic Access

Log Cannon provides a REST API for programmatic access. Authenticate with an API key.

### Authentication

Include your API key in requests:

\`\`\`bash
# Header method (preferred)
curl -H "X-Api-Key: your-key-here" https://your-instance/api/v1/logs

# Bearer token method
curl -H "Authorization: Bearer your-key-here" https://your-instance/api/v1/logs
\`\`\`

### Scopes

API keys have permission scopes:
- **ingest**: Write logs only (default for existing keys)
- **read**: Query logs, view dashboards/endpoints/queries
- **write**: Everything in read + create/update/delete resources
- **admin**: Everything in write + manage API keys

### Endpoints

#### Logs

\`\`\`bash
# Search logs
GET /api/v1/logs?source=MyApp&level=Error&search=timeout&limit=100

# Property filters
GET /api/v1/logs?prop.userId=123&prop.duration=>500
\`\`\`

#### Query

\`\`\`bash
# Execute arbitrary SELECT query
POST /api/v1/query
Content-Type: application/json

{"sql": "SELECT source, count() as count FROM logs.events GROUP BY source"}
\`\`\`

#### Dashboards

\`\`\`bash
GET /api/v1/dashboards              # List all
GET /api/v1/dashboards/:name        # Get one
POST /api/v1/dashboards             # Create
PATCH /api/v1/dashboards/:name      # Update
DELETE /api/v1/dashboards/:name     # Delete
\`\`\`

#### Endpoints (Stored Queries)

\`\`\`bash
GET /api/v1/endpoints               # List all
GET /api/v1/endpoints/:name?param=value  # Execute with params
POST /api/v1/endpoints              # Create
PATCH /api/v1/endpoints/:name       # Update
DELETE /api/v1/endpoints/:name      # Delete
\`\`\`

#### Saved Queries

\`\`\`bash
GET /api/v1/saved-queries           # List all
POST /api/v1/saved-queries          # Create
DELETE /api/v1/saved-queries/:id    # Delete
\`\`\`

#### API Keys (admin scope required)

\`\`\`bash
GET /api/v1/keys                    # List all (keys masked)
POST /api/v1/keys                   # Create (returns key once)
PATCH /api/v1/keys/:id              # Update name/scopes/enabled
DELETE /api/v1/keys/:id             # Revoke
\`\`\`

### Error Responses

\`\`\`json
{
  "error": "error_code",
  "message": "Human-readable description",
  "details": { "fields": { "name": "Required field" } }
}
\`\`\`

Error codes: \`unauthorized\`, \`forbidden\`, \`not_found\`, \`validation_error\`, \`query_error\`, \`query_timeout\`, \`internal_error\`
```

**Step 2: Commit**

```bash
git add dashboard/src/app/llms.txt/route.ts
git commit -m "docs: add API v1 documentation to llms.txt"
```

---

## Task 11: Add scopes to API key creation UI (update clickhouse.ts)

**Files:**
- Modify: `dashboard/src/lib/clickhouse.ts`

**Step 1: Update createAPIKey to accept scopes**

```typescript
// Find the createAPIKey function and update it:

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
```

**Step 2: Update APIKey interface**

```typescript
// Update the APIKey interface:

export interface APIKey {
  key_id: string;
  api_key: string;
  name: string;
  scopes: string;
  created_at: string;
  enabled: number;
}
```

**Step 3: Update getAPIKeys query**

```typescript
// Update the getAPIKeys function to include scopes:

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
```

**Step 4: Commit**

```bash
git add dashboard/src/lib/clickhouse.ts
git commit -m "feat: add scopes support to API key functions"
```

---

## Task 12: Final integration test

**Step 1: Start the services**

Run: `docker compose up -d`

**Step 2: Apply the schema migration**

Run: `docker exec -it log-cannon-clickhouse clickhouse-client --query "ALTER TABLE logs.api_keys ADD COLUMN IF NOT EXISTS scopes String DEFAULT 'ingest'"`

**Step 3: Create a test API key with admin scope via UI or direct insert**

Run:
```bash
docker exec -it log-cannon-clickhouse clickhouse-client --query "INSERT INTO logs.api_keys (api_key, name, scopes, enabled) VALUES ('test-admin-key-12345', 'Test Admin Key', 'admin', 1)"
```

**Step 4: Test the API endpoints**

```bash
# Test logs endpoint
curl -H "X-Api-Key: test-admin-key-12345" http://localhost:3000/api/v1/logs

# Test query endpoint
curl -X POST -H "X-Api-Key: test-admin-key-12345" -H "Content-Type: application/json" \
  -d '{"sql":"SELECT count() as count FROM logs.events"}' \
  http://localhost:3000/api/v1/query

# Test dashboards endpoint
curl -H "X-Api-Key: test-admin-key-12345" http://localhost:3000/api/v1/dashboards

# Test keys endpoint (admin)
curl -H "X-Api-Key: test-admin-key-12345" http://localhost:3000/api/v1/keys
```

**Step 5: Verify auth errors**

```bash
# No key - should return 401
curl http://localhost:3000/api/v1/logs

# Invalid key - should return 401
curl -H "X-Api-Key: invalid" http://localhost:3000/api/v1/logs
```

**Step 6: Clean up test key**

Run:
```bash
docker exec -it log-cannon-clickhouse clickhouse-client --query "ALTER TABLE logs.api_keys DELETE WHERE api_key = 'test-admin-key-12345'"
```

**Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete API v1 implementation with API key auth"
```

---

## Summary

This plan implements:

1. **Schema migration** - `scopes` column on `api_keys` table
2. **Auth utility** - `lib/api-auth.ts` with scope checking
3. **API routes**:
   - `GET /api/v1/logs` - Search logs
   - `POST /api/v1/query` - Execute SELECT queries
   - `GET/POST/PATCH/DELETE /api/v1/dashboards[/:name]`
   - `GET/POST/PATCH/DELETE /api/v1/endpoints[/:name]`
   - `GET/POST/DELETE /api/v1/saved-queries[/:id]`
   - `GET/POST/PATCH/DELETE /api/v1/keys[/:id]` (admin)
4. **Middleware update** - Bypass Clerk for `/api/v1/`
5. **Documentation** - API docs added to `llms.txt`
