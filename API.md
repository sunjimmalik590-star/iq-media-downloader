# HTTP contracts

Every service-to-service POST is UTF-8 JSON, signed over **exact raw body bytes** with HMAC-SHA256. Headers are `X-IQ-Timestamp` (Unix seconds) and `X-IQ-Signature` (lowercase hex). The signed input is `timestamp + '.' + rawBody`; timestamps outside ±300 seconds are rejected. JSON must not be parsed and reserialized before signature verification.

## Cloudflare

| Route | Authentication | Behavior |
|---|---|---|
| `POST /telegramWebhook` | `X-Telegram-Bot-Api-Secret-Token` | Persist a unique update ID; enqueue asynchronously; return `200 {"ok":true}`. Invalid secret → 403. Storage unavailable → 503, not a false success. |
| `POST /workerCallback` | HMAC | Compare-and-set processing→uploading and persist payload; enqueue delivery. Repeated or terminal callbacks return 200 without a second send. |
| `GET /health` | None | Safe booleans for Telegram identity, database and worker configuration. Degraded checks → 503. |

Successful worker callback:

```json
{
  "job_id": "UUID",
  "status": "completed",
  "file_url": "https://WORKER/files/UUID/SHORT_LIVED_RANDOM_TOKEN",
  "mime_type": "video/mp4",
  "file_size": 123456,
  "title": "Actual title",
  "artist": "Actual artist or empty string",
  "duration": 32
}
```

Failure uses `job_id`, `status: "failed"`, and `error_code`. Allowed error codes are `PRIVATE_CONTENT`, `MEDIA_UNAVAILABLE`, `MEDIA_TOO_LARGE`, `FORMAT_UNAVAILABLE`, `DOWNLOAD_TIMEOUT`, `UNSUPPORTED_LINK`, `BLOCKED_URL`. Optional `error_message` is never sent to users and is discarded by the backend's callback validator.

## FastAPI worker

| Route | Authentication | Behavior |
|---|---|---|
| `POST /health` | HMAC | Check yt-dlp, ffmpeg/ffprobe and writable temp storage. |
| `GET /health` | None | Same safe health response for Render health checks. |
| `POST /metadata` | HMAC | Real bounded yt-dlp extraction; normalized available formats. |
| `POST /download` | HMAC | Validate fixed payload, reserve unique job, return 202 and `worker_job_id` immediately. |
| `GET /files/{job_id}/{token}` | Expiring random bearer token | Stream exact job file, no-store headers; invalid/expired/released → 404. |
| `POST /release` | HMAC | Idempotently invalidate token and delete files after delivery. |
| `POST /cancel` | HMAC | Stop the subprocess group, invalidate token and delete files. Backend separately enforces who may cancel. |

Metadata input:

```json
{"source_url":"https://PUBLIC_SUPPORTED_URL","platform":"YouTube","max_file_size":47185920}
```

Download input:

```json
{
  "job_id": "UUID",
  "source_url": "https://PUBLIC_SUPPORTED_URL",
  "platform": "YouTube",
  "requested_format": "video",
  "requested_quality": "ACTUAL_METADATA_QUALITY",
  "format_id": "ACTUAL_24_HEX_METADATA_ID",
  "max_file_size": 47185920,
  "max_redirects": 5,
  "timeout_ms": 300000,
  "callback_url": "https://BACKEND/workerCallback"
}
```

These are schema examples, not successful live downloads. Format IDs are opaque hashes of the real offered selection, never arbitrary yt-dlp selectors. The worker re-extracts and validates the exact selected format/quality before downloading. The backend's cached selection ID is resolved to a real worker format only if cache reuse fails.

`/release` and `/cancel` receive `{"job_id":"UUID"}`. Unknown job IDs are safe idempotent successes. Unknown fields are rejected on input; users cannot pass shell commands, cookies or FFmpeg/yt-dlp options.
