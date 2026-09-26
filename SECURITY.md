# Security and recovery model

## Trust boundaries

- Telegram → Cloudflare: constant-time webhook-secret comparison, bounded raw body, persistent update-ID uniqueness. A database failure returns 503, allowing Telegram to retry. Queue insertion failure leaves a durable queued record for cron recovery.
- Cloudflare ↔ worker: HMAC-SHA256 of `timestamp + '.' + exact raw UTF-8 body`, lowercase hexadecimal, ±300-second freshness. WebCrypto verification and Python `hmac.compare_digest` avoid data-dependent comparisons. Paths are fixed by server code. Callback destination is checked against the configured exact endpoint.
- Worker → public sources: one custom yt-dlp HTTP transport. Each URL and redirect is checked; all DNS answers must be public. The socket connects to a vetted numeric address, retains TLS hostname verification and checks the peer. No hostname is re-resolved during connection. Private, loopback, link-local, multicast, reserved, transition IPv6 and cloud metadata destinations are blocked. Only standard HTTP/HTTPS ports are allowed.
- Worker → FFmpeg: downloaded local files only; argument arrays with `shell=False`, local file/pipe protocol whitelist, no user flags. Real ffprobe verifies streams; file size is checked during transfer and after processing. Separate process groups allow timeouts and cancellation to terminate FFmpeg children.

Only the security request handler is registered. Native HTTP/DASH and preflighted unencrypted HLS VOD can download. The native HLS wrapper rejects encryption/live/unsupported manifests before yt-dlp can delegate to a network-capable FFmpeg downloader. Deno runs installed EJS components with yt-dlp's restricted permissions; dynamic component downloads are disabled. Ordinary public player metadata is allowed, but authentication, paywall, private account, DRM and session-cookie workflows are unavailable.

## File lifecycle

Every UUID job owns `/tmp/iq/<uuid>/`. Symlinks and path traversal are rejected. Output filenames come only from an internal extension allowlist. Result routes require the matching random token (256 bits), exact job, completed state, and unexpired TTL. Responses disable caching. Cloudflare accepts only HTTPS files from the configured worker origin and `/files/<same-job>/<token>` path; redirects are disabled. Content-Length and MIME must match the signed callback.

After delivery or known failure Cloudflare signs `/release`; cancellation signs `/cancel`. Worker expiry runs every 15 seconds and deletes expired files; result URLs immediately fail at expiry even before the next sweep. Startup removes orphan job directories. Access logging is disabled so bearer file URLs are not printed. Review provider-level request logging separately.

## Idempotency and persistent records

Unique update IDs, a unique active user/URL index, compare-and-set format selection, processing-only callback acceptance and an uploading delivery claim guard duplicate work. Terminal status changes are rejected by a database trigger. A known stale cached file ID has one explicit uploading→processing recovery transition; it invalidates the cache and resolves a real format again. Uploading cannot be cancelled.

The SQLite repository tests execute the actual migration and SQL. D1 is the production adapter; it must be deployed and checked separately. MediaCache is not removed by clear-history or routine cleanup. It stores `file_id`, not media files or public URLs.

## Crash boundaries and known limitations

No Telegram send can be made atomic with a separate database transaction. A crash after Telegram accepts a file but before database commit may leave an unconfirmed send. The delivery claim prevents an automatic resend; cleanup marks the job expired with `DELIVERY_UNCERTAIN`. An operator checks Telegram and the ledger before retrying. Inbox processing also favors no repeated external side effects: a worker crash after claiming an update marks it failed after its lease timeout rather than replaying it blindly. Pending job stages remain recoverable from database state.

Worker jobs and duplicate registry are in memory and do not survive a Render restart. D1 is unaffected. Outstanding jobs eventually expire; users can request again. A second worker replica is not supported until dispatch and file storage are externalized. Temporary file byte budgets and concurrency are bounded, but load/memory behavior must still be tested on the chosen host. Metadata can make multiple HTTP requests, each guarded and bounded.

## Secrets and logging

Production tokens live in provider secret stores. `.env`, `.dev.vars`, database files and local runtime state are ignored. Subprocesses receive no service secret/token environment keys. Do not enable raw request logging, dump signed callbacks, print Telegram URLs containing bot tokens, or add user cookies. Audit records store event names, numeric actor IDs, UUID job IDs and safe error codes only. Store necessary job URLs in the private database; do not publish the database or live evidence containing personal data.

## Responsible use

Only public or authorized media may be downloaded. The bot rejects unsupported/private/DRM content with a safe message. It never supplies bypass instructions or alternate private-session extraction paths. Report extractor changes with a redacted public reproduction URL and rerun security tests after updating yt-dlp and its matching EJS package.
