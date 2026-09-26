# IQ MEDIA DOWNLOADER — STRICT AUDIT REPORT

Audit date: **2026-09-26**

**FINAL STATUS: PARTIALLY VERIFIED**

This is a new standalone implementation. It is not a deployed or production-ready bot. The real @iqTLbot end-to-end sequence has not been run.

## Project and isolation

**Project path:** `/workspace/scratch/b6b087f9445d/iq-media-downloader`

**Files created:** 63 deliverable files. See `FILE_MANIFEST.txt` for the complete source, deployment, test and evidence inventory. Dependency installations, local databases, local test secrets and build outputs are excluded from the deliverable.

**Existing projects:** No changes were made to IB DATA BOX, the frozen Base44 IQ Media Downloader foundation or any other existing project. The frozen foundation's reported 69/69 tests are user-supplied reference information, not tests run here. No Base44 API was invented or invoked.

**Repository:** New local Git repository; no external Git remote configured or pushed. The ZIP contains the complete source tree without local Git/dependency/runtime directories.

**Architecture:** TypeScript Cloudflare Worker → persistent D1 repositories and Cloudflare Queues → Python 3.12 FastAPI worker → yt-dlp with restricted native transports → local FFmpeg → HMAC callback → bounded streaming multipart Telegram delivery → atomic `file_id` cache and completed job. Scheduled cleanup and durable pending-work recovery are implemented.

## Build and automated verification

| Check | Actual result |
|---|---|
| TypeScript strict typecheck | PASS |
| Cloudflare Wrangler deployment dry run | PASS; no remote deployment performed |
| Backend tests | **64 passed, 0 failed** |
| Python worker tests | **70 passed, 0 failed** |
| Real local workerd tests | **6 passed, 0 failed** (5 child checks plus their parent test) |
| Total test-runner count | **140 passed, 0 failed** |
| D1 local migration through Wrangler | PASS; initial migration applied |
| Real workerd D1 migration | PASS |
| Python dependency consistency | PASS; no broken requirements |
| Docker image build | BLOCKED: Docker CLI/engine unavailable in this environment |
| Production deployment and live E2E | BLOCKED: required credentials and service configuration absent |

Full final command output is in `verification/`. Earlier test/configuration defects found during development were fixed before these final runs. The last gates include the actual worker subprocess import path, not only in-process imports.

Test doubles are restricted to `tests/`. Telegram calls and external media-source responses used in offline tests are explicitly mocked. They are not live success evidence. Real local tests did execute yt-dlp metadata and download code against a controlled HTTP fixture, create actual MP4/audio files, run FFmpeg remux/audio extraction and ffprobe validation, and reject oversized output without silently truncating success.

The normal Wrangler development CLI hit this environment's `uv_interface_addresses` restriction. The dedicated Miniflare/workerd test runner successfully executed the actual Worker handlers, database migration, HMAC verification and FixedLengthStream path. This limitation does not imply a remote Cloudflare failure or success.

A Starlette/httpx test-client deprecation warning remains in the test environment; tests passed. npm also reports an environment proxy-config warning. Neither was treated as live verification.

## Components

| Component | Implemented | Tested evidence | LIVE VERIFIED |
|---|---|---|---|
| Cloudflare | Yes | Typecheck, bundle, real local runtime | No remote deployment |
| Render | Dockerfile, startup, Blueprint | Configuration/source inspected | No; image build unavailable |
| Database | Seven domain entities, indexes, triggers, transactional batches | Actual SQLite SQL and local D1 migrations/runtime | No remote database |
| Telegram webhook | Secret auth, update types, persistent dedupe, async queue | Direct-handler and real local workerd checks | No registered live webhook |
| Worker | FastAPI endpoints, async process groups, concurrency, callbacks, expiry | API, security, subprocess and runner tests | No hosted service |
| yt-dlp | Installed **2026.8.19** | Actual controlled-source metadata/download path | No public-platform E2E |
| FFmpeg | Installed local **6.1.1** plus ffprobe | Actual remux, audio extraction, MIME/stream and size checks | No deployed media delivery |
| JavaScript extraction runtime | Deno **2.9.5**, matching yt-dlp-ejs **0.8.0** | Installed and dependency checked | YouTube not live verified |

## Platforms

`SUPPORTED` describes the implemented public-content adapter and transport path. It does not guarantee that a particular link or hosting IP works. `TESTED` below names the actual scope.

| Platform | DETECTED | IMPLEMENTED / SUPPORTED path | TESTED scope | LIVE VERIFIED |
|---|---|---|---|---|
| TikTok | Yes | yt-dlp adapter | Detection and shared mocked orchestration | No |
| Instagram | Yes | yt-dlp adapter | Detection and shared mocked orchestration | No |
| Facebook | Yes | yt-dlp adapter | Detection and shared mocked orchestration | No |
| YouTube | Yes | yt-dlp + installed EJS/Deno | Detection and shared mocked orchestration | No |
| X / Twitter | Yes | yt-dlp adapter | Detection and shared mocked orchestration | No |
| Reddit | Yes | yt-dlp adapter | Detection and shared mocked orchestration | No |
| Pinterest | Yes | yt-dlp adapter | Detection and shared mocked orchestration | No |
| Direct public media | Yes | Generic yt-dlp adapter | Detection plus real processing with mocked public HTTP source | No |

No platform was marked LIVE VERIFIED from unit tests. Encrypted HLS, live streams, playlists/albums, private/login-only/DRM content and unsupported external-downloader formats are rejected. Public native HTTP/DASH and unencrypted HLS VOD are the supported download transports; platform-specific compatibility requires real checks.

## Security

| Control | Implementation and evidence |
|---|---|
| SSRF | Public-only DNS results, numeric-address pinning, TLS hostname verification, per-request/redirect checks, unsafe ports/protocols/userinfo rejection, private and special IPv4/IPv6 blocks. Tests cover private destinations, DNS mixed answers, redirects and hop limits. |
| HMAC | Exact raw body, timestamp window, lowercase hex, constant-time verification; fixed Python/TypeScript cross-language vector, invalid signatures, expiry, body changes and BOM tampering tested. |
| Secret handling | No real token/key supplied or committed. Examples are blank/placeholders; tests use obvious synthetic values. Child process environments exclude secret/token keys. Raw URL access logs disabled. |
| Idempotency | Unique update IDs, active user/link index, guarded format selection/callback acceptance/delivery claim. Duplicate events and repeated taps/callbacks tested. |
| Rate limiting | Configurable 5 requests/minute/user, failure-triggered cooldown, global active-job ceiling, worker semaphore. Boundary and concurrency tests passed. |
| Terminal states | SQL trigger rejects terminal status changes. Uploading cannot be cancelled. Only an explicitly rejected stale cached ID can recover uploading→processing. |
| Files | Job-bound token, TTL, deletion after release/failure/cancel/timeout, path/symlink protection, actual stream inspection, size ceilings and restricted local FFmpeg demuxers. |
| Admin access | Current allowlist checked on every admin callback; maintenance preserves admin access. Non-admin mutations rejected in tests. |
| Cache | Actual-cache algorithm tested with mock Telegram IDs; repeat request skips worker metadata/download. Stale-ID fallback, hit counters and independent history clearing tested. |

## Real E2E evidence

| Required evidence | Actual status |
|---|---|
| `/start` from real @iqTLbot | NOT RUN |
| Real user URL received by deployed webhook | NOT RUN |
| Real public-source metadata | NOT RUN |
| Real Telegram format buttons | NOT RUN |
| User selection → hosted worker download | NOT RUN |
| Hosted worker → signed callback | NOT RUN |
| Actual Telegram media delivery and playback | NOT RUN |
| Remote completed database job | NOT RUN |
| Real Telegram file_id/file_unique_id stored | NOT RUN |
| Repeat real request → cache hit | NOT RUN |
| Proof of no second worker download | NOT RUN |

## Remaining blockers

1. Privately configure the actual @iqTLbot token, fresh Telegram webhook secret and shared worker HMAC secret.
2. Provision **new** Cloudflare Worker, D1 database and queues; provide the actual database ID, bot admin IDs and service origins.
3. Provision the separate Render Docker service, verify signed health and deploy with matching configuration. Docker image validation must run on a Docker-capable host.
4. Register @iqTLbot's webhook and verify `getMe`, `getWebhookInfo`, `/start`, then real media delivery.
5. Record a second request proving `file_id` reuse with no second downloader request. Repeat real tests for every platform to earn its own LIVE VERIFIED status.

## Remaining defects and operational limitations

- **No known failing automated test remains.** This is not a claim that production is defect-free; deployment, network compatibility and load behavior have not been verified.
- Telegram send and database commit cannot be one transaction. Ambiguous delivery is recorded as `DELIVERY_UNCERTAIN` and is never blindly resent; an operator must inspect Telegram before retrying.
- Worker registry/files are ephemeral and single-instance. A restart can expire in-flight jobs; D1 records/cache persist. Horizontal worker scaling requires externalized dispatch/result storage.
- Cached media retains its original Telegram send method; new Send Mode settings apply to fresh downloads.
- Render free-plan cold starts/resource limits and public platform restrictions remain live risks, with configurable limits. No all-platform success or always-on/free hosting guarantee is made.
- Base44 synchronization is intentionally absent and unverified; the frozen dashboard does not reflect the new database.

**FINAL STATUS: PARTIALLY VERIFIED**
