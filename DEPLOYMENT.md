# Deploy IQ Media Downloader as a new project

This guide provisions only **new IQ resources**. Do not point commands at IB DATA BOX, the frozen Base44 foundation, an existing worker, or an existing database. No deployment has been performed by this repository's creation.

## 1. Create a new source repository

Use a new empty private GitHub or GitLab repository named `iq-media-downloader`. Push this directory only. The included `.gitignore` excludes real secrets, local databases, dependencies and runtime state. No remote repository URL is preconfigured. When starting from the ZIP, initialize its extracted source directory as a new repository first:

```bash
git init -b main
git add .
git commit -m "Initialize IQ Media Downloader"
```

```bash
git remote add origin YOUR_NEW_REPOSITORY_URL
git push -u origin main
```

Use the included lockfiles. Requires Node 24+ and Python 3.12+. Validate before deploying:

```bash
npm ci
python3 -m venv .venv
.venv/bin/pip install -r worker/requirements.lock
.venv/bin/pip install -r worker/requirements-dev.txt
npm run build
npm test
npm run test:worker
npm run test:runtime
```

## 2. Create new Cloudflare database and queues

Authenticate to the intended Cloudflare account. Check account and billing/plan availability yourself; the project does not enable paid features automatically.

```bash
npx wrangler login
npx wrangler whoami
npx wrangler d1 create iq-media-downloader
npx wrangler queues create iq-media-events
npx wrangler queues create iq-media-dead-letter
```

Copy the new database ID into `cloudflare/wrangler.toml`. Keep `database_name = "iq-media-downloader"` and binding `DB`. Do not reuse a database belonging to another app.

```bash
npm run db:remote
npx wrangler d1 execute iq-media-downloader --remote --config cloudflare/wrangler.toml --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

The migration creates `bot_users`, `download_jobs`, `media_cache`, `telegram_updates`, `bot_settings`, `audit_logs`, `broadcasts`, plus `broadcast_recipients` and `leases`. Global limits and active-link uniqueness are evaluated inside serialized SQL writes. Database vendors must preserve these guarantees when porting.

## 3. Configure bot and secrets

In Telegram open the official **@BotFather**, run `/mybots`, and select **@iqTLbot**. Retrieve that bot's token privately. Do not create a second bot to impersonate the username, and do not use a token from another project. The setup script checks the actual username with `getMe` before changing the webhook.

Create a fresh webhook secret (16–256 characters using letters, digits, `_`, `-`) and a high-entropy worker secret (at least 32 characters). Use a password manager. The worker HMAC secret must be identical on Cloudflare and Render. Do not put production values in source code, screenshots, audit reports or prompts.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN --config cloudflare/wrangler.toml
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --config cloudflare/wrangler.toml
npx wrangler secret put DOWNLOAD_WORKER_SECRET --config cloudflare/wrangler.toml
```

Set `ADMIN_TELEGRAM_IDS` to comma-separated numeric IDs you have independently confirmed. No ID is pre-authorized in this project. `/admin` checks these IDs on every action.

## 4. Create the Render worker

Create a **new** Render Web Service connected to the new repository, or import its `render.yaml` Blueprint. Use Docker, root build context `.`, Dockerfile `worker/Dockerfile`, health route `/health`. The Docker image contains Python 3.12, FFmpeg/ffprobe, yt-dlp, matching EJS and Deno, and runs as an unprivileged user with a single Uvicorn process.

Set these Render environment variables:

| Variable | Value |
|---|---|
| `DOWNLOAD_WORKER_SECRET` | Same HMAC secret as Cloudflare |
| `PUBLIC_WORKER_URL` | Render's exact HTTPS service origin, without trailing path |
| `CALLBACK_BASE_URL` | New Cloudflare HTTPS origin, without a path |
| `MAX_CONCURRENT_JOBS` | `5` initially; reduce if the host cannot sustain it |
| `MAX_QUEUED_JOBS` | `20` |
| `MAX_FILE_SIZE` | `47185920`, equal to or above the backend policy |
| `TEMP_FILE_TTL` | `900` seconds |
| `DOWNLOAD_TIMEOUT_MS` | `300000` |
| `PORT` | `10000` |

The initial origins can be set after Render assigns its service URL and Cloudflare assigns its `workers.dev` URL. Deploy both services and update these exact origins before webhook registration. The worker cannot start with missing/invalid service configuration.

No Telegram bot token is needed on Render. Files are ephemeral and need no persistent disk. Keep **one instance** and **one Uvicorn process**; the current dispatcher is intentionally single-instance. Free Render idle spin-down and resource limits can affect downloader reliability. Do not claim always-on production behavior from the free Blueprint. No spending was authorized or incurred by this implementation.

Optional local container validation on a machine with Docker:

```bash
docker build -f worker/Dockerfile -t iq-media-worker .
docker run --rm --env-file YOUR_PRIVATE_WORKER_ENV_FILE -p 10000:10000 iq-media-worker
```

Do not commit the private environment file.

## 5. Deploy Cloudflare

Set `APP_BASE_URL` and `DOWNLOAD_WORKER_URL` in `cloudflare/wrangler.toml` to the exact new origins. Configure policy variables there. The default file limit is a policy, not an inferred provider entitlement.

```bash
npm run deploy
```

Routes provided by this Worker are `POST /telegramWebhook`, `POST /workerCallback`, and `GET /health`. `workers_dev=true` exposes the new Worker origin. For a custom domain, add a Cloudflare custom domain specifically to this Worker; do not repoint another project's route. Queue consumers and the minute cron are defined in Wrangler.

## 6. Verify worker and backend health

Export the needed environment variables locally using your secure secret manager. The scripts read environment variables without printing tokens.

```bash
python3 scripts/signed_worker_health.py
```

Require all of `yt_dlp`, `ffmpeg`, `temp_writable` to be true and status `ok`. `GET https://YOUR-IQ-WORKER.onrender.com/health` is also available to Render's health checker. Signed `POST /health` verifies the shared secret.

Open `https://YOUR-CLOUDFLARE-ORIGIN/health`. It checks D1 and calls Telegram `getMe`, requiring the bot to be @iqTLbot. `worker_configured` means configuration exists, not that worker health or platform downloads were verified. A broken bot identity/config returns a degraded response, never a fake `ok`.

## 7. Register the webhook and commands

With `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `APP_BASE_URL` in the local environment:

```bash
python3 scripts/telegram_setup.py check
python3 scripts/telegram_setup.py register
python3 scripts/telegram_setup.py check
```

Registration uses `/telegramWebhook`, the correct `secret_token`, and allowed updates `message`, `edited_message`, `callback_query`. It does **not** drop pending updates. It also registers `/start`, `/help`, `/history`, `/settings`, `/admin`.

The script calls `getWebhookInfo`. Require `webhook_matches: true`; inspect pending count and any last-error date. Provider logs must not expose secrets or bearer file URLs. A webhook can point to only one endpoint; this step intentionally moves **@iqTLbot** to the new backend. It does not modify Base44 source or data.

## 8. First real Telegram test

1. Open **@iqTLbot** and send `/start`. Check the exact name, tagline and four menu buttons.
2. Send a short, publicly accessible video that you own or are authorized to download. Keep the file below the configured limit.
3. Check the real title/type/duration and formats. No invented resolutions should appear.
4. Tap one actual format once; then tap again to exercise duplicate protection.
5. Wait for real Telegram media delivery. Play the file. Confirm it is the requested media and format.
6. Read the new D1 job. It must be `completed`, with real `telegram_file_id`, `telegram_file_unique_id`, correct URL hash, format/quality, and `cache_hit=0`.
7. Confirm an audit event `telegram_delivery_completed`. Verify the associated worker directory is deleted after release.
8. Send the exact same normalized media link again and choose the same format. Confirm another real message is delivered using the stored `file_id`.
9. The second job must be `completed`, `cache_hit=1`, and have no worker job ID. Cache hit_count and last_used_at must advance. There must be no second worker download request.

Useful read-only queries:

```bash
npx wrangler d1 execute iq-media-downloader --remote --config cloudflare/wrangler.toml --command "SELECT id,user_id,platform,status,format,quality,cache_hit,worker_job_id,telegram_file_id,error_code FROM download_jobs ORDER BY created_at DESC LIMIT 10;"
npx wrangler d1 execute iq-media-downloader --remote --config cloudflare/wrangler.toml --command "SELECT cache_key,platform,format,quality,send_method,hit_count,created_at,last_used_at FROM media_cache ORDER BY last_used_at DESC LIMIT 10;"
npx wrangler d1 execute iq-media-downloader --remote --config cloudflare/wrangler.toml --command "SELECT event,job_id,created_at FROM audit_logs ORDER BY id DESC LIMIT 20;"
```

Preserve private evidence using `docs/LIVE_VERIFICATION.md`. Only after this full sequence may status become **PRODUCTION READY**. Repeat platform-specific tests before marking each platform LIVE VERIFIED.

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| Webhook 403 | Match `TELEGRAM_WEBHOOK_SECRET` and re-register with the same secret. |
| Callback/worker 403 | Check shared HMAC key, exact body bytes and synchronized server clocks. |
| Bot does nothing | Check getWebhookInfo, allowed updates, D1 inbox, queue consumer binding and minute cron. |
| Metadata unavailable | Public/private availability, cold start, hosting-region blocks, extractor version and actual supported transports. Do not add stolen cookies. |
| Job processing too long | Render restart, worker saturation, callback URL, clock skew, failing signed callback; let bounded expiry recover capacity. |
| Wrong MIME/size | Inspect real FFprobe output and signed callback fields; never relax validation to accept arbitrary HTML. |
| Telegram rejects file ID | Known stale IDs invalidate automatically and trigger a real new download. Other delivery failures are not blindly resent. |
| DELIVERY_UNCERTAIN | Check Telegram manually before requesting again; a send may have succeeded before the connection failed. |
| Missing files after deploy | Expected ephemeral storage; do not use Render's disk as persistent bot storage. |
| Queue dead-letter messages | Inspect safe job/update IDs and database state. Avoid replaying claimed Telegram sends. Pending job stages are recovered by cron. |
| Free service resource errors | Lower concurrency/file policy or choose a suitable host after checking current quotas/cost. |

## 10. Portability and backup

Back up D1 through Cloudflare's official database tooling. Keep cache scoped to @iqTLbot; a different bot cannot reuse its IDs. To move hosting, preserve domain contracts, the HMAC signing scheme, SQL transaction semantics and secrets through secure transfer. Change service origins on both sides and re-register the bot webhook. Never copy an unrelated project's database or credentials.
