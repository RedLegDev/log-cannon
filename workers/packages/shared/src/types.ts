/** Value stored in KV for each API key. */
export interface APIKeyEntry {
  name: string;
  enabled: boolean;
}

/** Bindings shared by all ingest workers. */
export interface Env {
  INGEST_QUEUE: Queue<QueuePayload>;
  API_KEYS: KVNamespace;
  DISCOVERY_MODE?: string;
}

/**
 * Raw payload pushed to the queue. The worker does NO parsing — it just tags
 * the raw body with metadata so the consumer knows how to process it.
 */
export interface QueuePayload {
  /** Which ingest format: "clef", "webhook", "otlp-logs", "otlp-traces" */
  format: "clef" | "webhook" | "otlp-logs" | "otlp-traces";

  /** Source name resolved from the API key. */
  source: string;

  /**
   * The raw request body, base64-encoded.
   * Base64 is required because queue messages are JSON and the body may be
   * arbitrary binary (e.g. protobuf).
   */
  body: string;

  /** Original Content-Type header so the consumer can choose parser. */
  contentType: string;

  /** Webhook preset name (only for format "webhook"). */
  preset?: string;
}
