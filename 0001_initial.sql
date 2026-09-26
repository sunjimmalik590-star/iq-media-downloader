PRAGMA foreign_keys = ON;
CREATE TABLE bot_users (
 id TEXT PRIMARY KEY, username TEXT, chat_id TEXT NOT NULL,
 language TEXT NOT NULL DEFAULT 'en', default_quality TEXT NOT NULL DEFAULT 'best',
 send_mode TEXT NOT NULL DEFAULT 'media' CHECK(send_mode IN ('media','document')),
 notifications INTEGER NOT NULL DEFAULT 1, blocked INTEGER NOT NULL DEFAULT 0,
 cooldown_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE download_jobs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES bot_users(id), chat_id TEXT NOT NULL,
 normalized_url TEXT NOT NULL, source_url_hash TEXT NOT NULL, platform TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','awaiting_format','processing','uploading','completed','failed','cancelled','expired')),
 metadata TEXT, format TEXT, quality TEXT, format_id TEXT, cache_key TEXT,
 worker_job_id TEXT, dispatch_started INTEGER, dispatch_attempts INTEGER NOT NULL DEFAULT 0,
 callback TEXT, delivery_started INTEGER, cache_hit INTEGER NOT NULL DEFAULT 0,
 send_method TEXT, telegram_file_id TEXT, telegram_file_unique_id TEXT, error_code TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 hidden_history INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX one_active_link_per_user ON download_jobs(user_id,source_url_hash)
 WHERE status IN ('queued','awaiting_format','processing','uploading');
CREATE INDEX jobs_user_created ON download_jobs(user_id,created_at DESC);
CREATE INDEX jobs_status_updated ON download_jobs(status,updated_at);
CREATE TRIGGER enforce_job_transition BEFORE UPDATE OF status ON download_jobs
 WHEN OLD.status != NEW.status AND NOT (
 (OLD.status='queued' AND NEW.status IN ('awaiting_format','failed','cancelled','expired')) OR
 (OLD.status='awaiting_format' AND NEW.status IN ('processing','uploading','failed','cancelled','expired')) OR
 (OLD.status='processing' AND NEW.status IN ('uploading','failed','cancelled','expired')) OR
 (OLD.status='uploading' AND NEW.status IN ('completed','failed','expired')) OR
 (OLD.status='uploading' AND NEW.status='processing' AND OLD.cache_hit=1 AND NEW.cache_hit=0)
 ) BEGIN SELECT RAISE(ABORT,'ILLEGAL_JOB_TRANSITION'); END;
CREATE TABLE media_cache (
 cache_key TEXT PRIMARY KEY, source_url_hash TEXT NOT NULL, platform TEXT NOT NULL,
 format TEXT NOT NULL, quality TEXT NOT NULL, send_method TEXT NOT NULL,
 telegram_file_id TEXT NOT NULL, telegram_file_unique_id TEXT NOT NULL,
 mime_type TEXT NOT NULL, file_size INTEGER NOT NULL,
 hit_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
);
CREATE INDEX cache_source ON media_cache(source_url_hash);
CREATE TABLE telegram_updates (
 update_id INTEGER PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE bot_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO bot_settings VALUES ('maintenance','false');
CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, event TEXT NOT NULL, job_id TEXT, detail TEXT, created_at INTEGER NOT NULL);
CREATE INDEX audit_created ON audit_logs(created_at DESC);
CREATE TABLE broadcasts (
 id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, text TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','queued','sending','completed','cancelled')),
 total_recipients INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0,
 failed_count INTEGER NOT NULL DEFAULT 0, blocked_count INTEGER NOT NULL DEFAULT 0,
 pending_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE broadcast_recipients (
 broadcast_id TEXT NOT NULL REFERENCES broadcasts(id), user_id TEXT NOT NULL,
 chat_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
 PRIMARY KEY(broadcast_id,user_id)
);
CREATE TABLE leases (name TEXT PRIMARY KEY, until_at INTEGER NOT NULL);
