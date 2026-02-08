import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { queryClickHouse } from '@/lib/clickhouse';
import { createMcpServer } from '@/lib/mcp-server';
import type { ApiScope } from '@/lib/api-auth';

interface ApiKeyRecord {
  key_id: string;
  api_key: string;
  name: string;
  scopes: string;
  enabled: number;
}

function parseScopes(scopesStr: string): ApiScope[] {
  if (!scopesStr) return ['ingest'];
  return scopesStr.split(',').map(s => s.trim()) as ApiScope[];
}

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
    const sql = `
      SELECT toString(key_id) as key_id, api_key, name, scopes, enabled
      FROM logs.api_keys
      WHERE api_key = '${apiKey.replace(/'/g, "''")}'
      LIMIT 1
    `;
    const results = await queryClickHouse<ApiKeyRecord>(sql);

    if (results.length === 0) {
      return new Response(
        JSON.stringify({ error: 'unauthorized', message: 'Invalid API key' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const key = results[0];
    if (!key.enabled) {
      return new Response(
        JSON.stringify({ error: 'unauthorized', message: 'API key is disabled' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return { scopes: parseScopes(key.scopes) };
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
    return await transport.handleRequest(request);
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
