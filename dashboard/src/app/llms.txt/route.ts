import { getOverviewDocs, getStaticOverviewDocs } from '@/lib/docs-content';
import { parseSessionCookie } from '@/lib/auth/session';

export async function GET(req: Request) {
  try {
    const secret = process.env.AUTH_SECRET;
    const email = secret
      ? await parseSessionCookie(req.headers.get('cookie'), secret)
      : null;

    if (email) {
      const fullDocument = await getOverviewDocs();
      return new Response(fullDocument, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          // Live inventory must not land in shared caches.
          'Cache-Control': 'private, no-store',
        },
      });
    }

    return new Response(getStaticOverviewDocs(), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(`# Log Cannon \n\nError generating documentation: ${errorMessage}\n\nPlease ensure ClickHouse is running and accessible.`, {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }
}
