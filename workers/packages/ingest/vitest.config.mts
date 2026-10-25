import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The config is loaded as ESM, where __dirname is not defined.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(here, "migrations"));

      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // The spill bucket is production-only in wrangler.toml.
          r2Buckets: ["BASIN_SPILL"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            // The worker reads its vars from wrangler.toml and does not see
            // a test-side mutation of `env`, so the slow-request threshold
            // has to be lowered here. 1 ms means any request that does real
            // I/O reports, which is what test/slow-path.test.ts asserts on.
            SLOW_REQUEST_MS: "1",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // workerd (1.20261019) reports an unhandled rejection for a bad gzip body
    // even when every stream promise is handled in JS. body.test.ts and
    // slow-path.test.ts send one on purpose and assert the 400; only that
    // exact error is dropped.
    onUnhandledError: (error) =>
      !(error.name === "TypeError" && error.message === "Decompression failed."),
  },
});
