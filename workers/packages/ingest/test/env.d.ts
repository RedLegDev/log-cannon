declare module "cloudflare:test" {
  interface ProvidedEnv {
    KEYS_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    BASIN_SPILL: R2Bucket;
  }
}
