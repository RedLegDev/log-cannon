import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { lookupKey } from '@/lib/key-registry';
import { createMcpServer } from '@/lib/mcp-server';
import type { ApiScope } from '@/lib/api-auth';

async function authenticateRequest(request: Request): Promise<{ scopes: ApiScope[] } | Response> {
  const apiKey =
    request.headers.get('x-api-key') ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'unauthorized', message: 'Missing API key. Provide X-Api-Key header or Authorization: Bearer <key>' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const record = await lookupKey(apiKey);

    if (!record) {
      return new Response(
        JSON.stringify({ error: 'unauthorized', message: 'Invalid API key' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (!record.enabled) {
      return new Response(
        JSON.stringify({ error: 'unauthorized', message: 'API key is disabled' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return { scopes: record.scopes as ApiScope[] };
  } catch {
    return new Response(
      JSON.stringify({ error: 'internal_error', message: 'Authentication failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;

  const server = createMcpServer(auth.scopes);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });

  await server.connect(transport);

  try {
    // The MCP SDK transport requires Accept to include both application/json and
    // text/event-stream, but many clients omit the SSE type. Since we use
    // enableJsonResponse (stateless, JSON-only), SSE is never sent — so we
    // normalize the header to satisfy the SDK check.
    const accept = request.headers.get('accept') || '';
    let normalizedRequest = request;
    if (!accept.includes('text/event-stream')) {
      const headers = new Headers(request.headers);
      headers.set('accept', 'application/json, text/event-stream');
      normalizedRequest = new Request(request, { headers });
    }
    return await transport.handleRequest(normalizedRequest);
  } finally {
    await server.close();
  }
}

export async function GET() {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method Not Allowed. Use POST for MCP requests.' },
      id: null,
    }),
    { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } },
  );
}

export async function DELETE() {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Session management not supported in stateless mode.' },
      id: null,
    }),
    { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } },
  );
}
