import { getBuildInfo } from '@/lib/build-info';

/** "2026-06-01 14:46 UTC" from an ISO string, or null if unparseable. */
function formatUtc(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/**
 * Tiny build stamp rendered in the global footer on every page. Server
 * component — reads the baked stamp directly, no client fetch.
 */
export function BuildFooter() {
  const { buildTime } = getBuildInfo();
  const built = formatUtc(buildTime);

  return (
    <footer className="text-center py-4 text-xs text-text-muted font-mono">
      {built ? `built ${built}` : 'dev build'}
    </footer>
  );
}
