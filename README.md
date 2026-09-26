# ⚡ IQ Media Downloader

**Download. Fast. Simple.** · Telegram target: **@iqTLbot**

New standalone project. The IB DATA BOX project and existing Base44 IQ Media Downloader foundation are outside this repository and were not modified.

**Status: PARTIALLY VERIFIED.** Local code, database, security, and media-processing tests are available. There is no real Telegram end-to-end evidence yet. Never treat an offline test as platform verification.

## Architecture

Telegram calls the lightweight TypeScript Cloudflare Worker. D1 persists users, jobs, update IDs, settings, cache, audits, and broadcasts. Cloudflare Queues runs metadata, dispatch and delivery work after webhook acknowledgement. A cron recovers durable pending work and cleans expired jobs.

The separate Python 3.12 FastAPI worker runs yt-dlp and FFmpeg in cancellable subprocess groups. Only short-lived, unguessable job URLs expose results. Cloudflare streams multipart file bytes directly to Telegram without accumulating a media-sized buffer. It commits the returned Telegram `file_id` and completed job atomically. Repeat requests use the cache without another worker metadata or download call.

| Component | Location | Responsibilities |
|---|---|---|
| Cloudflare backend | `cloudflare/src/` | Webhook auth, queue, bot UI, repository, HMAC callbacks, streaming Telegram delivery |
| Persistent database | `cloudflare/migrations/` | Seven logical domain entities plus broadcast-recipient and lease support tables |
| Download worker | `worker/iq_worker/` | Metadata, native HTTP/DASH/HLS download, local-only FFmpeg, callback, expiry |
| Contracts | `shared/` | Job states, formats, callback and queue contracts |
| Automated tests | `tests/` | Real SQLite and local media operations; explicitly labelled network doubles |
| Deployment | `cloudflare/wrangler.toml`, `render.yaml` | Separate new Cloudflare and Render resources |

## Local setup

Requirements: Node 24+, Python 3.12+, FFmpeg with ffprobe. Docker is needed to build the Render image.

```bash
npm ci
python3 -m venv .venv
.venv/bin/pip install -r worker/requirements.lock
.venv/bin/pip install -r worker/requirements-dev.txt
npm run typecheck
npm test
npm run test:worker
npm run build
npm run test:runtime
npm run db:local
```

Use `.env.example` as a reference. Set worker variables securely in your environment and run:

```bash
PYTHONPATH=worker .venv/bin/python -m iq_worker.serve
```

Both configured service origins must be HTTPS. Local unit tests supply their own synthetic configuration; they do not need production secrets. For an actual local Telegram integration, use independently provisioned HTTPS endpoints. Do not weaken SSRF rules to allow localhost download sources.

## Features

- `/start`, `/help`, `/history`, `/settings`, `/admin`; private-chat operation.
- Metadata-driven format buttons, cancellation, preferences and translation entry point.
- Administrators are exclusively the numeric IDs in `ADMIN_TELEGRAM_IDS`; every admin callback checks again.
- Queued text broadcasts with preview, explicit queue action, cancellation and recipient statistics.
- Configurable request limits, failure cooldown, global capacity, worker concurrency and file ceiling.
- `file_id` cache reuse, stale-ID fallback, clear history without cache deletion.
- Signed exact-body HMAC requests and callbacks; DNS-pinned public-only transport for extractor requests, segments and redirects.
- No cookies, login credentials, arbitrary command flags, DRM unlocking or access-control bypass accepted from users.

## Honest platform status

All eight requested platform families have detection/adapters. Site-specific extraction delegates to yt-dlp through the security transport. **None is LIVE VERIFIED.** Public availability, region restrictions and hosting-IP restrictions can change.

Supported download transports are native HTTP, DASH and unencrypted HLS VOD. Live streams, playlists/albums, encrypted HLS and formats that require external network-capable downloaders are rejected. Unknown direct-video resolution appears as **Original**, never a fabricated quality. Audio is offered only when metadata establishes an audio source. Video remuxing uses stream-copy where possible; audio extraction uses AAC stream-copy or MP3 conversion. Non-MP4 video is delivered as a document for compatibility.

## Operational constraints

- Use one Render instance and one Uvicorn process. Worker job registry and files are intentionally ephemeral. D1 is the persistent authority; restarts can expire in-flight downloads. Horizontal worker scaling needs a durable dispatcher/object store before enabling it.
- Telegram has no client-supplied idempotency key for sending media. Delivery claims prevent duplicate callbacks from resending. If a network failure makes a send outcome ambiguous, the job is marked `DELIVERY_UNCERTAIN`; it is not blindly resent. Inspect Telegram before manually retrying.
- Cached files preserve their original Telegram send type; a user changing Send Mode affects new downloads. Telegram cannot freely change the type of an existing `file_id`.
- Render free hosting may sleep and reset local storage; this is a trial configuration, not an uptime guarantee. Reduce worker concurrency to fit the chosen service resources. No paid services were provisioned here.

Read [Deployment](docs/DEPLOYMENT.md), [Security](docs/SECURITY.md), [Provider limits](docs/PROVIDER_LIMITS.md), [Base44 integration](docs/BASE44_INTEGRATION.md), and [Strict audit](docs/STRICT_AUDIT.md) before going live.
