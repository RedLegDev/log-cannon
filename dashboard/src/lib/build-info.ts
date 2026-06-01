import rawBuildInfo from '@/generated/version.json';

export interface BuildInfo {
  /** ISO 8601 time the image was built, or null for un-stamped local builds. */
  buildTime: string | null;
}

/**
 * Resolves the build time baked into the image at `src/generated/version.json`
 * by the Docker build. Runtime env var `BUILD_TIME` takes precedence when set.
 */
export function getBuildInfo(): BuildInfo {
  const buildTime = process.env.BUILD_TIME || rawBuildInfo.buildTime || null;
  return { buildTime };
}
