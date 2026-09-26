// Small provider adapter interfaces. Domain code does not import a Cloudflare SDK.
export interface SqlResult<T = Record<string, unknown>> { results: T[]; meta: {changes: number} }
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run(): Promise<SqlResult>;
}
export interface SqlDatabase { prepare(sql: string): SqlStatement; batch(statements: SqlStatement[]): Promise<SqlResult[]> }
export interface WorkQueue { send(body: unknown, options?: {delaySeconds?: number}): Promise<void> }
export interface Env {
  DB: SqlDatabase; EVENTS: WorkQueue;
  TELEGRAM_BOT_TOKEN: string; TELEGRAM_WEBHOOK_SECRET: string;
  DOWNLOAD_WORKER_URL: string; DOWNLOAD_WORKER_SECRET: string;
  APP_BASE_URL: string; ADMIN_TELEGRAM_IDS: string;
  [key: string]: unknown;
}
export interface Context {waitUntil(promise: Promise<unknown>): void}
export interface QueueMessage<T> {body: T; ack(): void; retry(options?: {delaySeconds?: number}): void}
export interface QueueBatch<T> {messages: QueueMessage<T>[]}
export interface FixedLengthStreamType {new(length: number): {readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>}}
