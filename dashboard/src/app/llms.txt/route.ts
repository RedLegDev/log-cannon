import { getOverviewDocs } from '@/lib/docs-content';

export async function GET() {
  try {
    const fullDocument = await getOverviewDocs();

    return new Response(fullDocument, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=60'
      }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(`# Log Cannon \n\nError generating documentation: ${errorMessage}\n\nPlease ensure ClickHouse is running and accessible.`, {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  }
}
