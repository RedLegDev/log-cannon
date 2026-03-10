import { API_DOCS } from '@/lib/docs-content';

export async function GET() {
  return new Response(API_DOCS, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
