import rawBuildInfo from '@/generated/version.json';

export interface BuildInfo {
  /** Short commit SHA (7 chars), or "dev" for un-stamped local builds. */
  commit: string;
  /** Full commit SHA, or "dev". */
  commitFull: string;
  /** ISO 8601 author/commit date, or null if unknown. */
  commitDate: string | null;
  /** ISO 8601 time the image was built, or null if unknown. */
  buildTime: string | null;
  /** Branch/ref the image was built from, or "dev". */
  branch: string;
  /** Base repository URL, or null for un-stamped builds. */
  repoUrl: string | null;
  /** Deep link to the built commit on the repo host, or null. */
  commitUrl: string | null;
}

const REPO_URL = (process.env.GITHUB_REPO_URL || 'https://github.com/RedLegDev/log-cannon').replace(/\/+$/, '');

/**
 * Resolves the build stamp baked into the image at `src/generated/version.json`
 * (written by the Docker `stamp` stage from the repo's git metadata).
 *
 * Runtime env vars `GIT_COMMIT` / `BUILD_TIME` take precedence when set, so a
 * non-GitOps or manual build can still report an accurate stamp without the
 * git context wired in. Falls back to the committed "dev" placeholder locally.
 */
export function getBuildInfo(): BuildInfo {
  const commitFull = process.env.GIT_COMMIT || rawBuildInfo.commitFull || rawBuildInfo.commit || 'dev';
  const isStamped = commitFull !== 'dev';
  const commit = isStamped ? commitFull.slice(0, 7) : 'dev';
  const buildTime = process.env.BUILD_TIME || rawBuildInfo.buildTime || null;
  const commitDate = rawBuildInfo.commitDate || null;
  const branch = rawBuildInfo.branch || 'dev';
  const repoUrl = isStamped ? REPO_URL : null;
  const commitUrl = repoUrl ? `${repoUrl}/commit/${commitFull}` : null;

  return { commit, commitFull, commitDate, buildTime, branch, repoUrl, commitUrl };
}
