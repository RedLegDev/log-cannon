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

---

## Client-Side Logging (Browser)

For logging from React components and client-side code, you need a browser-compatible logger that batches events and sends them reliably.

### 1. CORS Configuration

If your Log-Cannon instance is on a different domain than your app, proxy requests through an API route to avoid exposing credentials:

```typescript
// app/api/logs/route.ts
export const runtime = 'edge';

export async function POST(request: Request) {
  const body = await request.text();

  const response = await fetch(`${process.env.LOG_CANNON_URL}/ingest/clef`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.serilog.clef',
      'X-Seq-ApiKey': process.env.LOG_CANNON_API_KEY!,
    },
    body,
  });

  return new Response(null, { status: response.status });
}
```

### 2. Browser Logger Utility

Create a client-side logger that batches logs and uses `sendBeacon` for reliable delivery:

```typescript
// lib/client-logger.ts
'use client';

interface LogEvent {
  '@t': string;
  '@l': string;
  '@mt': string;
  '@x'?: string;
  [key: string]: unknown;
}

type LogLevel = 'Verbose' | 'Debug' | 'Information' | 'Warning' | 'Error' | 'Fatal';

class ClientLogger {
  private buffer: LogEvent[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private endpoint: string;
  private flushThreshold: number;
  private flushIntervalMs: number;
  private commonProperties: Record<string, unknown>;

  constructor(options: {
    endpoint?: string;
    flushThreshold?: number;
    flushIntervalMs?: number;
    commonProperties?: Record<string, unknown>;
  } = {}) {
    this.endpoint = options.endpoint ?? '/api/logs';
    this.flushThreshold = options.flushThreshold ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.commonProperties = options.commonProperties ?? {};

    if (typeof window !== 'undefined') {
      this.startAutoFlush();
      this.setupUnloadHandler();
    }
  }

  private startAutoFlush() {
    this.flushInterval = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  private setupUnloadHandler() {
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.flush(true); // Use sendBeacon
      }
    });

    window.addEventListener('pagehide', () => {
      this.flush(true); // Use sendBeacon
    });
  }

  private log(level: LogLevel, template: string, props?: Record<string, unknown>) {
    this.buffer.push({
      '@t': new Date().toISOString(),
      '@l': level,
      '@mt': template,
      ...this.commonProperties,
      ...this.getClientContext(),
      ...props,
    });

    if (this.buffer.length >= this.flushThreshold) {
      this.flush();
    }
  }

  private getClientContext(): Record<string, unknown> {
    if (typeof window === 'undefined') return {};

    return {
      ClientUrl: window.location.href,
      ClientPath: window.location.pathname,
      UserAgent: navigator.userAgent,
      ScreenWidth: window.screen.width,
      ScreenHeight: window.screen.height,
      Referrer: document.referrer || undefined,
    };
  }

  verbose(template: string, props?: Record<string, unknown>) { this.log('Verbose', template, props); }
  debug(template: string, props?: Record<string, unknown>) { this.log('Debug', template, props); }
  info(template: string, props?: Record<string, unknown>) { this.log('Information', template, props); }
  warn(template: string, props?: Record<string, unknown>) { this.log('Warning', template, props); }
  error(template: string, props?: Record<string, unknown>) { this.log('Error', template, props); }
  fatal(template: string, props?: Record<string, unknown>) { this.log('Fatal', template, props); }

  flush(useBeacon = false) {
    if (this.buffer.length === 0) return;

    const events = this.buffer.splice(0, this.buffer.length);
    const body = events.map(e => JSON.stringify(e)).join('\n');

    if (useBeacon && navigator.sendBeacon) {
      // sendBeacon for reliable delivery during page unload
      const blob = new Blob([body], { type: 'application/vnd.serilog.clef' });
      navigator.sendBeacon(this.endpoint, blob);
    } else {
      fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.serilog.clef' },
        body,
        keepalive: true, // Allows request to outlive the page
      }).catch(err => {
        console.error('Failed to send logs:', err);
        // Re-add failed events to buffer for retry
        this.buffer.unshift(...events);
      });
    }
  }

  setCommonProperty(key: string, value: unknown) {
    this.commonProperties[key] = value;
  }

  destroy() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    this.flush();
  }
}

// Singleton instance
export const logger = new ClientLogger();

// Hook for React components
export function useLogger() {
  return logger;
}
```

### 3. React Error Boundary

Capture and log React component errors:

```typescript
// components/LoggingErrorBoundary.tsx
'use client';

import { Component, ReactNode } from 'react';
import { logger } from '@/lib/client-logger';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class LoggingErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('React component error {ErrorMessage}', {
      ErrorMessage: error.message,
      '@x': error.stack,
      ComponentStack: errorInfo.componentStack,
    });
    logger.flush(); // Immediately flush errors
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div>Something went wrong. Please refresh the page.</div>
      );
    }

    return this.props.children;
  }
}
```

### 4. Global Error Handler

Capture unhandled errors and promise rejections:

```typescript
// lib/global-error-handler.ts
'use client';

import { logger } from '@/lib/client-logger';

export function setupGlobalErrorHandlers() {
  if (typeof window === 'undefined') return;

  window.onerror = (message, source, lineno, colno, error) => {
    logger.error('Uncaught error {Message}', {
      Message: String(message),
      Source: source,
      Line: lineno,
      Column: colno,
      '@x': error?.stack,
    });
    logger.flush();
  };

  window.onunhandledrejection = (event) => {
    logger.error('Unhandled promise rejection {Reason}', {
      Reason: String(event.reason),
      '@x': event.reason instanceof Error ? event.reason.stack : undefined,
    });
    logger.flush();
  };
}
```

Initialize in your root layout:

```typescript
// app/layout.tsx
'use client';

import { useEffect } from 'react';
import { setupGlobalErrorHandlers } from '@/lib/global-error-handler';
import { LoggingErrorBoundary } from '@/components/LoggingErrorBoundary';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    setupGlobalErrorHandlers();
  }, []);

  return (
    <html>
      <body>
        <LoggingErrorBoundary>
          {children}
        </LoggingErrorBoundary>
      </body>
    </html>
  );
}
```

### 5. Usage in Components

```typescript
// components/CheckoutButton.tsx
'use client';

import { useLogger } from '@/lib/client-logger';

export function CheckoutButton({ cartId }: { cartId: string }) {
  const log = useLogger();

  const handleClick = async () => {
    log.info('Checkout initiated {CartId}', { CartId: cartId });

    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        body: JSON.stringify({ cartId }),
      });

      if (!response.ok) {
        log.error('Checkout failed {CartId} {StatusCode}', {
          CartId: cartId,
          StatusCode: response.status,
        });
        return;
      }

      log.info('Checkout completed {CartId}', { CartId: cartId });
    } catch (err) {
      log.error('Checkout error {CartId} {Error}', {
        CartId: cartId,
        Error: err instanceof Error ? err.message : String(err),
        '@x': err instanceof Error ? err.stack : undefined,
      });
    }
  };

  return <button onClick={handleClick}>Checkout</button>;
}
```

### 6. User Session Tracking

Track user sessions for log correlation:

```typescript
// lib/session.ts
'use client';

import { logger } from '@/lib/client-logger';

export function initializeSession(userId?: string) {
  const sessionId = crypto.randomUUID();

  logger.setCommonProperty('SessionId', sessionId);
  if (userId) {
    logger.setCommonProperty('UserId', userId);
  }

  logger.info('Session started {SessionId}', { SessionId: sessionId });

  return sessionId;
}
```

### Client-Side Best Practices

1. **Use a proxy route**: Avoid exposing your Log-Cannon URL and API key to the browser
2. **Batch aggressively**: Client-side logging should batch more (10+ events) to reduce requests
3. **Use `sendBeacon`**: For page unload, `sendBeacon` is more reliable than `fetch`
4. **Add `keepalive: true`**: Allows fetch requests to complete even if the page is closing
5. **Include client context**: URL, screen size, and user agent help with debugging
6. **Flush errors immediately**: Don't wait for batching on errors - flush right away
7. **Handle offline**: Consider queuing logs in localStorage for offline support

---

## Troubleshooting

- **No logs appearing**: Check API key is valid and enabled in Log-Cannon
- **401/403 errors**: Verify `X-Seq-ApiKey` header is set correctly
- **Logs delayed**: This is normal - `waitUntil` runs after response
- **Missing properties**: Ensure properties are JSON-serializable (no circular references)
- **Client logs blocked by CORS**: Use a proxy API route instead of calling Log-Cannon directly
- **Logs lost on page close**: Ensure `sendBeacon` fallback is working; check browser dev tools
