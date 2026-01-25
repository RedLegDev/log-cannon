# Log-Cannon Integration: Next.js on Cloudflare Pages

You are integrating a Next.js application running on Cloudflare Pages with Log-Cannon, a self-hosted log aggregation service.

## Overview

Log-Cannon accepts logs via HTTP POST in CLEF format (Serilog Compact Log Event Format). Your task is to create a logging utility that buffers log events during request handling and flushes them asynchronously after the response is sent.

## Ingestion Endpoint

- **URL**: `{LOG_CANNON_URL}/ingest/clef`
- **Method**: `POST`
- **Headers**:
  - `Content-Type: application/vnd.serilog.clef`
  - `X-Seq-ApiKey: {API_KEY}`
- **Body**: Newline-delimited JSON, one log event per line

## CLEF Format Specification

Each log event is a JSON object with these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `@t` | Yes | ISO 8601 timestamp (e.g., `2026-01-25T10:30:00.123Z`) |
| `@l` | No | Log level: `Verbose`, `Debug`, `Information`, `Warning`, `Error`, `Fatal`. Defaults to `Information` |
| `@mt` | Yes | Message template with placeholders like `{PropertyName}` |
| `@m` | No | Rendered message (if omitted, server renders from template) |
| `@x` | No | Exception/stack trace string |
| `@i` | No | Event type identifier (hash) |
| `*` | No | Any additional properties become searchable fields |

Example log events:
```json
{"@t":"2026-01-25T10:30:00.123Z","@l":"Information","@mt":"Request received {Method} {Path}","Method":"GET","Path":"/api/users"}
{"@t":"2026-01-25T10:30:00.456Z","@l":"Error","@mt":"Database query failed","@x":"Error: Connection timeout\n    at query()...","QueryDurationMs":5000}
```

## Implementation Requirements

### 1. Environment Variables

The application needs these environment variables:
```
LOG_CANNON_URL=https://logs.redleg.dev
LOG_CANNON_API_KEY=your-api-key-here
```

### 2. Logger Utility

Create a logger utility at `lib/logger.ts` (or similar) with:

- A buffer to collect log events during request processing
- Methods for each log level: `verbose`, `debug`, `info`, `warn`, `error`, `fatal`
- Each method accepts a message template and optional properties object
- A `flush` method that sends buffered logs using `ctx.waitUntil()` for non-blocking delivery
- Automatic timestamp generation for each event

```typescript
// lib/logger.ts
interface LogEvent {
  '@t': string;
  '@l': string;
  '@mt': string;
  '@x'?: string;
  [key: string]: unknown;
}

type LogLevel = 'Verbose' | 'Debug' | 'Information' | 'Warning' | 'Error' | 'Fatal';

export function createLogger() {
  const buffer: LogEvent[] = [];

  const log = (level: LogLevel, template: string, props?: Record<string, unknown>) => {
    buffer.push({
      '@t': new Date().toISOString(),
      '@l': level,
      '@mt': template,
      ...props,
    });
  };

  return {
    verbose: (template: string, props?: Record<string, unknown>) => log('Verbose', template, props),
    debug: (template: string, props?: Record<string, unknown>) => log('Debug', template, props),
    info: (template: string, props?: Record<string, unknown>) => log('Information', template, props),
    warn: (template: string, props?: Record<string, unknown>) => log('Warning', template, props),
    error: (template: string, props?: Record<string, unknown>) => log('Error', template, props),
    fatal: (template: string, props?: Record<string, unknown>) => log('Fatal', template, props),

    flush: (ctx: ExecutionContext) => {
      if (buffer.length === 0) return;

      const body = buffer.map(event => JSON.stringify(event)).join('\n');

      ctx.waitUntil(
        fetch(`${process.env.LOG_CANNON_URL}/ingest/clef`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/vnd.serilog.clef',
            'X-Seq-ApiKey': process.env.LOG_CANNON_API_KEY!,
          },
          body,
        }).catch(err => {
          console.error('Failed to flush logs to Log-Cannon:', err);
        })
      );
    },
  };
}
```

### 3. Usage in Route Handlers

In Cloudflare Pages, route handlers receive an `ExecutionContext` via the platform context:

```typescript
// app/api/example/route.ts
import { createLogger } from '@/lib/logger';

export const runtime = 'edge';

export async function GET(request: Request) {
  const ctx = (request as any).cf?.ctx || globalThis.__cf_ctx;
  const log = createLogger();

  log.info('API request started {Method} {Url}', {
    Method: request.method,
    Url: request.url,
  });

  try {
    // Your business logic here
    const result = await doSomething();

    log.info('Request completed successfully');
    log.flush(ctx);

    return Response.json(result);
  } catch (err) {
    log.error('Request failed {Error}', {
      Error: err instanceof Error ? err.message : String(err),
      '@x': err instanceof Error ? err.stack : undefined,
    });
    log.flush(ctx);

    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
```

### 4. Middleware Integration (Optional)

For application-wide logging, create middleware:

```typescript
// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const startTime = Date.now();

  // Log at start - note: middleware has limited access to ExecutionContext
  // Consider logging only in route handlers for full waitUntil support

  const response = NextResponse.next();

  // Add timing header for observability
  response.headers.set('X-Response-Time', `${Date.now() - startTime}ms`);

  return response;
}
```

### 5. Accessing ExecutionContext in Cloudflare Pages

Cloudflare Pages with Next.js provides the execution context differently depending on the adapter version. Common patterns:

```typescript
// Pattern 1: Via request object (newer adapters)
export async function GET(request: Request, context: { ctx: ExecutionContext }) {
  const { ctx } = context;
  // ...
}

// Pattern 2: Via getRequestContext helper
import { getRequestContext } from '@cloudflare/next-on-pages';

export async function GET(request: Request) {
  const { ctx } = getRequestContext();
  // ...
}
```

## Best Practices

1. **Always use `waitUntil`**: This ensures logs are sent after the response, not blocking the user
2. **Batch logs per request**: Create one logger instance per request, flush once at the end
3. **Include context**: Add request ID, user ID, path, and other contextual properties
4. **Use message templates**: Write `User {UserId} logged in` not `User 123 logged in` - this enables grouping in the dashboard
5. **Handle flush failures gracefully**: Don't let logging errors break your application
6. **Add exception details**: Use the `@x` field for stack traces

## Testing the Integration

After implementing, verify logs appear in Log-Cannon:

1. Make a request to your application
2. Open the Log-Cannon dashboard
3. Filter by your API key's source name
4. Confirm events appear with correct levels and properties

## Troubleshooting

- **No logs appearing**: Check API key is valid and enabled in Log-Cannon
- **401/403 errors**: Verify `X-Seq-ApiKey` header is set correctly
- **Logs delayed**: This is normal - `waitUntil` runs after response
- **Missing properties**: Ensure properties are JSON-serializable (no circular references)
