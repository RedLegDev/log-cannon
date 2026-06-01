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
  const { commit, commitFull, buildTime, commitUrl } = getBuildInfo();
  const built = formatUtc(buildTime);
  const hasCommit = commitFull !== 'dev';

  if (!hasCommit && !built) {
    return (
      <footer className="text-center py-4 text-xs text-text-muted font-mono">
        dev build
      </footer>
    );
  }

  return (
    <footer className="text-center py-4 text-xs text-text-muted font-mono">
      {hasCommit &&
        (commitUrl ? (
          <a
            href={commitUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={commitFull}
            className="hover:text-cannon-fire transition-colors"
          >
            {commit}
          </a>
        ) : (
          <span title={commitFull}>{commit}</span>
        ))}
      {hasCommit && built && <span> · </span>}
      {built && <span>built {built}</span>}
    </footer>
  );
}
