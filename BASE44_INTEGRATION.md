# Base44 integration boundary

The user reports that the existing Base44 IQ Media Downloader foundation has 69/69 passing self-tests, seven entities, an admin dashboard, Setup & Tests and a Go Live Checklist. That statement is a frozen reference, not a test result of this new repository.

This implementation never reads, writes, deploys, overwrites or shares credentials with that project, IB DATA BOX, or another existing application. There are no Base44 SDK calls or undocumented Base44 endpoints in the code.

Cloudflare D1 is the independent persistent system of record. The corresponding domain entities are BotUser, DownloadJob, MediaCache, TelegramUpdate, BotSettings, AuditLog and Broadcast. The SQL repository uses a small database adapter interface; an alternative database requires a tested adapter and equivalent transaction/uniqueness guarantees.

**Base44 database synchronization: NOT IMPLEMENTED / NOT VERIFIED.** The frozen dashboard does not automatically reflect the new system. The live bot's `/admin` menu reads the new database only.

Future synchronization must be separately authorized after an official server-side API and scoped credentials are verified. Begin with a read-only export from the new database into a separate integration environment. Define record ownership, tenant and bot identity, conflict handling and idempotent sync keys. Do not reuse Base44 IDs as new job IDs without an explicit mapping. Never upload bot tokens, HMAC keys, raw cookies or temporary bearer file URLs into a dashboard. Do not change the frozen project as an implicit integration step.
