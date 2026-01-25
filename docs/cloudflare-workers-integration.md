# Log-Cannon Integration: Next.js on Cloudflare Workers

You are integrating a Next.js application (or standalone Worker) running on Cloudflare Workers with Log-Cannon, a self-hosted log aggregation service.

## Overview

Log-Cannon accepts logs via HTTP POST in CLEF format (Serilog Compact Log Event Format). Your task is to create a logging utility that buffers log events during request handling and flushes them asynchronously using the Worker's `ExecutionContext.waitUntil()` method.

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
{"@t":"2026-01-25T10:30:00.123Z","@l":"Information","@mt":"Worker invoked {Method} {Path}","Method":"POST","Path":"/api/orders"}
{"@t":"2026-01-25T10:30:00.789Z","@l":"Error","@mt":"Order processing failed {OrderId}","OrderId":"abc-123","@x":"Error: Inventory unavailable\n    at processOrder()..."}
```

## Implementation Requirements

### 1. Environment Bindings

Define environment bindings in `wrangler.toml`:

```toml
[vars]
LOG_CANNON_URL = "https://logs.redleg.dev"

# For secrets, use: wrangler secret put LOG_CANNON_API_KEY
```

Or use the Cloudflare dashboard to set environment variables.

TypeScript interface for the environment:
```typescript
interface Env {
  LOG_CANNON_URL: string;
  LOG_CANNON_API_KEY: string;
  // ... other bindings
}
```

### 2. Logger Utility

Create a logger utility that works with Workers:

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

interface LoggerConfig {
  url: string;
  apiKey: string;
}

export function createLogger(config: LoggerConfig) {
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

    getBuffer: () => [...buffer],

    flush: (ctx: ExecutionContext) => {
      if (buffer.length === 0) return;

      const body = buffer.map(event => JSON.stringify(event)).join('\n');

      ctx.waitUntil(
        fetch(`${config.url}/ingest/clef`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/vnd.serilog.clef',
            'X-Seq-ApiKey': config.apiKey,
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

### 3. Standalone Worker Implementation

For a standalone Cloudflare Worker:

```typescript
// src/index.ts
import { createLogger } from './lib/logger';

interface Env {
  LOG_CANNON_URL: string;
  LOG_CANNON_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    const log = createLogger({
      url: env.LOG_CANNON_URL,
      apiKey: env.LOG_CANNON_API_KEY,
    });

    const url = new URL(request.url);

    log.info('Worker request started {RequestId} {Method} {Path}', {
      RequestId: requestId,
      Method: request.method,
      Path: url.pathname,
      Query: url.search,
      UserAgent: request.headers.get('user-agent'),
      CF_Ray: request.headers.get('cf-ray'),
    });

    try {
      // Route handling
      const response = await handleRequest(request, env, log);

      log.info('Worker request completed {RequestId} {StatusCode} {DurationMs}', {
        RequestId: requestId,
        StatusCode: response.status,
        DurationMs: Date.now() - startTime,
      });

      log.flush(ctx);
      return response;

    } catch (err) {
      log.error('Worker request failed {RequestId} {Error}', {
        RequestId: requestId,
        Error: err instanceof Error ? err.message : String(err),
        '@x': err instanceof Error ? err.stack : undefined,
        DurationMs: Date.now() - startTime,
      });

      log.flush(ctx);

      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

async function handleRequest(
  request: Request,
  env: Env,
  log: ReturnType<typeof createLogger>
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/api/health') {
    return new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (url.pathname === '/api/orders' && request.method === 'POST') {
    const body = await request.json();
    log.info('Processing order {OrderId}', { OrderId: body.orderId });

    // Business logic here...

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Not Found', { status: 404 });
}
```

### 4. Next.js on Workers (using @cloudflare/next-on-pages)

For Next.js applications deployed to Workers:

```typescript
// app/api/example/route.ts
import { createLogger } from '@/lib/logger';
import { getRequestContext } from '@cloudflare/next-on-pages';

export const runtime = 'edge';

interface Env {
  LOG_CANNON_URL: string;
  LOG_CANNON_API_KEY: string;
}

export async function POST(request: Request) {
  const { env, ctx } = getRequestContext<Env>();

  const log = createLogger({
    url: env.LOG_CANNON_URL,
    apiKey: env.LOG_CANNON_API_KEY,
  });

  log.info('API route invoked {Method} {Url}', {
    Method: request.method,
    Url: request.url,
  });

  try {
    const body = await request.json();

    // Your business logic
    const result = await processRequest(body, log);

    log.info('API route completed successfully');
    log.flush(ctx);

    return Response.json(result);

  } catch (err) {
    log.error('API route failed {Error}', {
      Error: err instanceof Error ? err.message : String(err),
      '@x': err instanceof Error ? err.stack : undefined,
    });
    log.flush(ctx);

    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
```

### 5. Durable Objects Integration

If using Durable Objects, pass the logger through:

```typescript
// src/durable-object.ts
import { createLogger } from './lib/logger';

interface Env {
  LOG_CANNON_URL: string;
  LOG_CANNON_API_KEY: string;
}

export class MyDurableObject {
  private env: Env;
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const log = createLogger({
      url: this.env.LOG_CANNON_URL,
      apiKey: this.env.LOG_CANNON_API_KEY,
    });

    log.info('Durable Object request {ObjectId}', {
      ObjectId: this.state.id.toString(),
    });

    // Note: Durable Objects don't have ExecutionContext
    // Use state.waitUntil instead
    try {
      const result = await this.handleRequest(request, log);

      this.state.waitUntil(
        this.flushLogs(log.getBuffer())
      );

      return result;
    } catch (err) {
      log.error('Durable Object error', {
        '@x': err instanceof Error ? err.stack : undefined,
      });
      this.state.waitUntil(this.flushLogs(log.getBuffer()));
      throw err;
    }
  }

  private async flushLogs(buffer: LogEvent[]): Promise<void> {
    if (buffer.length === 0) return;

    await fetch(`${this.env.LOG_CANNON_URL}/ingest/clef`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.serilog.clef',
        'X-Seq-ApiKey': this.env.LOG_CANNON_API_KEY,
      },
      body: buffer.map(e => JSON.stringify(e)).join('\n'),
    });
  }
}
```

## Best Practices

1. **Always use `waitUntil`**: Ensures logs are sent after the response without blocking
2. **Generate request IDs**: Use `crypto.randomUUID()` to correlate logs for the same request
3. **Include Cloudflare context**: Add `CF-Ray`, `CF-Connecting-IP`, and other CF headers as properties
4. **Use message templates**: Write `Order {OrderId} processed` not `Order abc-123 processed`
5. **Measure durations**: Track `DurationMs` for performance analysis
6. **Handle errors gracefully**: Always flush logs in catch blocks before re-throwing
7. **Keep secrets secure**: Use `wrangler secret` for API keys, not `wrangler.toml`

## Adding Request Context

Enhance logs with Cloudflare-specific information:

```typescript
function getRequestContext(request: Request) {
  const cf = (request as any).cf;
  return {
    CFRay: request.headers.get('cf-ray'),
    Country: cf?.country,
    City: cf?.city,
    Colo: cf?.colo,
    ClientIP: request.headers.get('cf-connecting-ip'),
    UserAgent: request.headers.get('user-agent'),
  };
}

// Usage
log.info('Request received {Method} {Path}', {
  Method: request.method,
  Path: new URL(request.url).pathname,
  ...getRequestContext(request),
});
```

## Scheduled Workers (Cron Triggers)

For scheduled workers, the pattern is similar:

```typescript
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const log = createLogger({
      url: env.LOG_CANNON_URL,
      apiKey: env.LOG_CANNON_API_KEY,
    });

    log.info('Scheduled job started {Cron}', {
      Cron: event.cron,
      ScheduledTime: new Date(event.scheduledTime).toISOString(),
    });

    try {
      await performScheduledTask(env, log);
      log.info('Scheduled job completed');
    } catch (err) {
      log.error('Scheduled job failed', {
        '@x': err instanceof Error ? err.stack : undefined,
      });
    }

    log.flush(ctx);
  },
};
```

## Testing the Integration

1. Deploy your Worker: `wrangler deploy`
2. Make a test request: `curl https://your-worker.workers.dev/api/health`
3. Open the Log-Cannon dashboard
4. Filter by your API key's source name
5. Verify events appear with expected properties

## Troubleshooting

- **No logs appearing**: Verify API key is valid and enabled
- **401/403 from Log-Cannon**: Check `X-Seq-ApiKey` header value
- **Logs truncated**: Each line must be valid JSON; check for unescaped characters
- **High latency**: `waitUntil` runs after response, so user-facing latency shouldn't be affected
- **Missing env vars**: Ensure secrets are set via `wrangler secret put`
