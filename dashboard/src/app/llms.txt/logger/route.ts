const LOGGER_DOCS = `# Log Cannon - Logger Integration

You are integrating logging into an application that sends logs to Log Cannon.

## Protocol

\`\`\`
POST {LOG_CANNON_URL}/ingest/clef
Headers:
  Content-Type: application/vnd.serilog.clef
  X-Seq-ApiKey: {API_KEY}
Body: Newline-delimited JSON (one event per line)
\`\`\`

## CLEF Format

Each log event is a JSON object:

| Field | Required | Description |
|-------|----------|-------------|
| @t    | Yes      | ISO 8601 timestamp (e.g., 2026-01-25T10:30:00.123Z) |
| @l    | No       | Level: Verbose, Debug, Information, Warning, Error, Fatal (default: Information) |
| @mt   | Yes      | Message template with {Placeholders} for structured logging |
| @i    | No       | Event type identifier. If omitted, auto-computed as MurmurHash3 of @mt (e.g. 0x5432a8ff). Events sharing a template share the same event type. |
| @x    | No       | Exception/stack trace string |
| *     | No       | Any additional properties become searchable fields |

Example events:
\`\`\`json
{"@t":"2026-01-25T10:30:00.123Z","@l":"Information","@mt":"Request {Method} {Path}","Method":"GET","Path":"/api/users"}
{"@t":"2026-01-25T10:30:00.456Z","@l":"Error","@mt":"Database query failed","@x":"Error: Connection timeout\\n    at query()...","QueryDurationMs":5000}
\`\`\`

## Server Logger (TypeScript)

Buffer logs during request handling, flush asynchronously after response using \`waitUntil()\`.

\`\`\`typescript
// lib/logger.ts
interface LoggerConfig {
  url: string;
  apiKey: string;
}

export function createLogger(config: LoggerConfig) {
  const buffer: Array<Record<string, unknown>> = [];

  const log = (level: string, template: string, props?: Record<string, unknown>) => {
    buffer.push({
      '@t': new Date().toISOString(),
      '@l': level,
      '@mt': template,
      ...props,
    });
  };

  return {
    verbose: (t: string, p?: Record<string, unknown>) => log('Verbose', t, p),
    debug: (t: string, p?: Record<string, unknown>) => log('Debug', t, p),
    info: (t: string, p?: Record<string, unknown>) => log('Information', t, p),
    warn: (t: string, p?: Record<string, unknown>) => log('Warning', t, p),
    error: (t: string, p?: Record<string, unknown>) => log('Error', t, p),
    fatal: (t: string, p?: Record<string, unknown>) => log('Fatal', t, p),

    // Call at end of request - waitUntil ensures delivery without blocking response
    flush: (ctx: ExecutionContext) => {
      if (buffer.length === 0) return;
      ctx.waitUntil(
        fetch(\`\${config.url}/ingest/clef\`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/vnd.serilog.clef',
            'X-Seq-ApiKey': config.apiKey,
          },
          body: buffer.map(e => JSON.stringify(e)).join('\\n'),
        }).catch(err => console.error('Log flush failed:', err))
      );
    },
  };
}
\`\`\`

### Server Usage

\`\`\`typescript
// In any request handler with ExecutionContext access
const log = createLogger({
  url: env.LOG_CANNON_URL,
  apiKey: env.LOG_CANNON_API_KEY,
});

log.info('Request started {Method} {Path}', {
  Method: request.method,
  Path: new URL(request.url).pathname,
});

try {
  const result = await handleRequest();
  log.info('Request completed {StatusCode}', { StatusCode: 200 });
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
\`\`\`

## Client Logger (Browser)

Batch logs to reduce requests, use \`sendBeacon\` for reliable delivery on page unload.

\`\`\`typescript
// lib/client-logger.ts
class ClientLogger {
  private buffer: Array<Record<string, unknown>> = [];
  private endpoint: string;
  private apiKey?: string;

  constructor(opts: { endpoint: string; apiKey?: string }) {
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    if (typeof window !== 'undefined') {
      setInterval(() => this.flush(), 5000); // Auto-flush every 5s
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flush(true);
      });
    }
  }

  private log(level: string, template: string, props?: Record<string, unknown>) {
    this.buffer.push({
      '@t': new Date().toISOString(),
      '@l': level,
      '@mt': template,
      ...props,
    });
    if (this.buffer.length >= 10) this.flush(); // Flush at 10 events
  }

  verbose(t: string, p?: Record<string, unknown>) { this.log('Verbose', t, p); }
  debug(t: string, p?: Record<string, unknown>) { this.log('Debug', t, p); }
  info(t: string, p?: Record<string, unknown>) { this.log('Information', t, p); }
  warn(t: string, p?: Record<string, unknown>) { this.log('Warning', t, p); }
  error(t: string, p?: Record<string, unknown>) { this.log('Error', t, p); }
  fatal(t: string, p?: Record<string, unknown>) { this.log('Fatal', t, p); }

  flush(useBeacon = false) {
    if (this.buffer.length === 0) return;
    const events = this.buffer.splice(0);
    const body = events.map(e => JSON.stringify(e)).join('\\n');

    if (useBeacon && navigator.sendBeacon) {
      // sendBeacon for page unload - doesn't support custom headers
      const url = this.apiKey
        ? \`\${this.endpoint}?apiKey=\${encodeURIComponent(this.apiKey)}\`
        : this.endpoint;
      navigator.sendBeacon(url, new Blob([body], { type: 'application/vnd.serilog.clef' }));
    } else {
      const headers: Record<string, string> = { 'Content-Type': 'application/vnd.serilog.clef' };
      if (this.apiKey) headers['X-Seq-ApiKey'] = this.apiKey;
      fetch(this.endpoint, { method: 'POST', headers, body, keepalive: true })
        .catch(err => console.error('Log flush failed:', err));
    }
  }
}

// Singleton - configure once, import anywhere
export const logger = new ClientLogger({
  endpoint: 'https://logs.example.com/ingest/clef',
  apiKey: 'your-client-api-key', // Use dedicated client key (write-only, rotatable)
});
\`\`\`

### Client Usage

\`\`\`typescript
import { logger } from '@/lib/client-logger';

// Log user actions
logger.info('Button clicked {ButtonId}', { ButtonId: 'checkout' });

// Log errors with stack traces
try {
  await submitOrder();
} catch (err) {
  logger.error('Order failed {Error}', {
    Error: err instanceof Error ? err.message : String(err),
    '@x': err instanceof Error ? err.stack : undefined,
  });
}
\`\`\`

## Key Patterns

1. **Message templates**: Use \`{Placeholders}\` not string interpolation - enables grouping in dashboards
2. **waitUntil (server)**: Ensures logs send after response, non-blocking
3. **sendBeacon (client)**: Reliable delivery during page unload
4. **Batch client logs**: Reduces network overhead, flush on threshold or interval
5. **Dedicated client API key**: Visible in browser, but write-only and rotatable
`;

export async function GET() {
  return new Response(LOGGER_DOCS, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
