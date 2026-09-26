import type {Env} from './runtime.ts';
export function integer(value: unknown, fallback: number, min = 1, max = 1_000_000_000): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('INVALID_CONFIGURATION');
  return n;
}
export function config(env: Env) {
  return {
    requestsPerMinute: integer(env.REQUESTS_PER_MINUTE, 5, 1, 1000),
    failureThreshold: integer(env.FAILURE_THRESHOLD, 3, 1, 100),
    failureWindow: integer(env.FAILURE_WINDOW_SECONDS, 600),
    cooldown: integer(env.COOLDOWN_SECONDS, 300),
    globalJobs: integer(env.GLOBAL_ACTIVE_JOBS, 20, 1, 1000),
    maxFileSize: integer(env.MAX_FILE_SIZE, 47_185_920),
    timeoutMs: integer(env.DOWNLOAD_TIMEOUT_MS, 300_000, 1000, 900_000),
    jobTtl: integer(env.JOB_TTL_SECONDS, 1800, 300),
    updateTtl: integer(env.UPDATE_TTL_SECONDS, 604800, 3600),
    broadcastBatch: integer(env.BROADCAST_BATCH_SIZE, 20, 1, 50),
    admins: new Set((env.ADMIN_TELEGRAM_IDS || '').split(',').map(s=>s.trim()).filter(s=>/^\d+$/.test(s)))
  };
}
export function assertConfiguration(env: Env): void {
  for (const key of ['TELEGRAM_BOT_TOKEN','TELEGRAM_WEBHOOK_SECRET','DOWNLOAD_WORKER_SECRET','APP_BASE_URL','DOWNLOAD_WORKER_URL']) {
    if (typeof env[key] !== 'string' || !(env[key] as string)) throw new Error('MISSING_CONFIGURATION');
  }
  if (env.DOWNLOAD_WORKER_SECRET.length < 32) throw new Error('WEAK_WORKER_SECRET');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) throw new Error('INVALID_WEBHOOK_SECRET');
  for (const key of ['APP_BASE_URL','DOWNLOAD_WORKER_URL'] as const) {
    const u = new URL(env[key]);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || u.pathname !== '/' || u.search || u.hash) throw new Error('INVALID_SERVICE_ORIGIN');
  }
  config(env);
}
