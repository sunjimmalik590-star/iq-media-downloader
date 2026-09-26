# Provider documentation and configuration

Official documents checked on **2026-09-26**. These are reference observations, not guarantees of a particular account's entitlement. Recheck before deployment.

| Topic | Official reference | Implementation decision |
|---|---|---|
| Telegram file sending | https://core.telegram.org/bots/api#sending-files | Current docs distinguish URL fetch limits from multipart uploads. Media uploads use streaming multipart. The default 47,185,920-byte ceiling is an application policy below the documented 50 MB multipart ceiling, not a claimed provider limit. |
| Telegram cache | https://core.telegram.org/bots/api#sending-files | `file_id` is bot-specific and tied to the original file type. Reuse its recorded send method. |
| Webhook secret/update types | https://core.telegram.org/bots/api#setwebhook | Register `secret_token` and message, edited_message, callback_query. |
| Telegram rate limits | https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this | Broadcasts pace at one message per 1.1 seconds with retry_after handling. No paid broadcasts. User request quota is independently configurable. |
| Worker streaming | https://developers.cloudflare.com/workers/runtime-apis/streams/ and https://developers.cloudflare.com/workers/runtime-apis/request/ | Streams and FixedLengthStream forward multipart media without a media-sized buffer. |
| D1 transactional batches | https://developers.cloudflare.com/d1/worker-api/d1-database/ | Batch cache+completion and broadcast recipient snapshots atomically. |
| Queues configuration | https://developers.cloudflare.com/queues/configuration/configure-queues/ | Batch size 1, max concurrency 5, configured retries, dead-letter queue; database outbox recovers missed enqueue operations. |
| Cloudflare runtime limits | https://developers.cloudflare.com/workers/platform/limits/ | Review selected plan CPU, wall time, subrequest, D1 and Queue quotas. No assumed unlimited/free capacity. |
| Render Docker | https://render.com/docs/docker | Root build context with worker Dockerfile; bind 0.0.0.0 and PORT. |
| Render filesystem | https://render.com/docs/deploys#ephemeral-filesystem | Temporary files and worker registry can disappear at deployment/restart. Persistent bot data stays in D1. |
| Render free hosting | https://render.com/docs/free | Documentation describes idle spin-down after 15 minutes and a cold-start delay. Plan availability, bandwidth and suitability for media loads require account-level verification. |
| yt-dlp dependencies | https://github.com/yt-dlp/yt-dlp/wiki/EJS | Deno and the matching installed yt-dlp-ejs version support YouTube's public-player extraction path. Remote component fetching stays disabled; no authentication cookies or external challenge bypass services. |

**NEEDS LIVE VERIFICATION:** plan access, prices, quotas, sustained transfer reliability, memory at concurrency 5, per-platform extraction from the chosen region/IP, and Telegram's acceptance of actual media from this deployed service. Environment values remain configurable.
