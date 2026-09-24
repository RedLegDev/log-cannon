import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

// The config is loaded as ESM, where __dirname is not defined.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(here, "migrations"));

  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              // The worker reads its vars from wrangler.toml and does not see
              // a test-side mutation of `env`, so the slow-request threshold
              // has to be lowered here. 1 ms means any request that does real
              // I/O reports, which is what test/slow-path.test.ts asserts on.
              SLOW_REQUEST_MS: "1",
            },
          },
        },
      },
    },
  };
});
