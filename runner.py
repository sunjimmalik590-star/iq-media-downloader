import asyncio
import json
import os
import re
import secrets
import shutil
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path
import httpx
from .config import Settings
from .errors import MediaError
from .security import signature


def job_directory(root: Path, job_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", job_id):
        raise MediaError("BLOCKED_URL")
    root = root.resolve()
    target = root / job_id
    if target.is_symlink() or target.resolve().parent != root:
        raise MediaError("BLOCKED_URL")
    return target


async def execute(payload: dict, timeout: float, temp_budget: int | None = None) -> dict:
    env = {k: v for k, v in os.environ.items() if not any(s in k.upper() for s in ("SECRET", "TOKEN", "PASSWORD", "API_KEY"))}
    proc = await asyncio.create_subprocess_exec(sys.executable, "-m", "iq_worker.task", stdin=asyncio.subprocess.PIPE,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                                                start_new_session=True, env=env,
                                                cwd=str(Path(__file__).resolve().parents[1]))
    communicate = asyncio.create_task(proc.communicate(json.dumps(payload).encode()))
    deadline = time.monotonic() + timeout
    try:
        while not communicate.done():
            if time.monotonic() >= deadline:
                raise MediaError("DOWNLOAD_TIMEOUT")
            if temp_budget and payload.get("directory"):
                used = sum(p.stat().st_size for p in Path(payload["directory"]).rglob("*") if p.is_file())
                if used > temp_budget:
                    raise MediaError("MEDIA_TOO_LARGE")
            await asyncio.wait([communicate], timeout=min(0.5, max(0.01, deadline-time.monotonic())))
        stdout, _ = communicate.result()
        if len(stdout) > 262144:
            raise MediaError("MEDIA_UNAVAILABLE")
        try:
            result = json.loads(stdout)
        except (ValueError, UnicodeError):
            raise MediaError("MEDIA_UNAVAILABLE") from None
        if not result.get("ok"):
            raise MediaError(result.get("error_code", "MEDIA_UNAVAILABLE"))
        return result["result"]
    finally:
        # Kill the whole child process group, including any running FFmpeg, even on cancellation.
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        if not communicate.done():
            await communicate
        await proc.wait()


@dataclass
class WorkerJob:
    id: str
    fingerprint: str
    status: str
    created_at: float
    expires_at: float
    token: str = ""
    result: dict | None = None
    task: asyncio.Task | None = None


class JobRunner:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.jobs: dict[str, WorkerJob] = {}
        self.semaphore = asyncio.Semaphore(settings.concurrency)
        self.metadata_slots = asyncio.Semaphore(2)
        self.root = settings.temp_root
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    async def metadata(self, payload: dict):
        async with self.metadata_slots:
            return await execute({**payload, "operation": "metadata"}, self.settings.metadata_timeout)

    def submit(self, payload: dict) -> str:
        import hashlib
        job_id = payload["job_id"]
        directory = job_directory(self.root, job_id)
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        existing = self.jobs.get(job_id)
        if existing:
            if existing.fingerprint != fingerprint:
                raise MediaError("BLOCKED_URL")
            return job_id
        if sum(j.status in ("queued", "processing", "completed") for j in self.jobs.values()) >= self.settings.max_jobs:
            raise MediaError("MEDIA_UNAVAILABLE")
        now = time.time()
        job = WorkerJob(job_id, fingerprint, "queued", now, now + self.settings.ttl)
        self.jobs[job_id] = job
        job.task = asyncio.create_task(self.run(job, payload, directory))
        return job_id

    async def run(self, job: WorkerJob, payload: dict, directory: Path):
        callback = {"job_id": job.id, "status": "failed", "error_code": "MEDIA_UNAVAILABLE", "error_message": "Download failed"}
        try:
            async with self.semaphore:
                if time.time() > job.expires_at:
                    raise MediaError("DOWNLOAD_TIMEOUT")
                job.status = "processing"
                directory.mkdir(mode=0o700, parents=False, exist_ok=False)
                remaining = min(payload["timeout_ms"] / 1000, job.expires_at - time.time())
                result = await execute({**payload, "operation": "download", "directory": str(directory)}, remaining,
                                       payload["max_file_size"] * 3 + 2_000_000)
                path = directory / result["filename"]
                if path.resolve().parent != directory.resolve() or not path.is_file() or path.is_symlink():
                    raise MediaError("BLOCKED_URL")
                if path.stat().st_size != result["file_size"] or path.stat().st_size > payload["max_file_size"]:
                    raise MediaError("MEDIA_TOO_LARGE")
                job.result = result
                job.token = secrets.token_urlsafe(32)
                job.status = "completed"
                job.expires_at = time.time() + self.settings.ttl
                callback = {"job_id": job.id, "status": "completed", **{k: v for k, v in result.items() if k != "filename"},
                            "file_url": f"{self.settings.public_url}/files/{job.id}/{job.token}"}
        except asyncio.CancelledError:
            self.remove_files(job)
            job.status = "cancelled"
            return
        except Exception as error:
            job.status = "failed"
            self.remove_files(job)
            callback["error_code"] = error.code if isinstance(error, MediaError) else "MEDIA_UNAVAILABLE"
        try:
            await self.callback(callback, job)
        except asyncio.CancelledError:
            self.remove_files(job)
            job.status = "cancelled"
        except Exception:
            self.remove_files(job)
            job.status = "failed"

    async def callback(self, payload: dict, job: WorkerJob):
        raw = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
        # Callback origin is administrator configuration, never taken from the request.
        async with httpx.AsyncClient(timeout=20, follow_redirects=False, trust_env=False) as client:
            for attempt in range(7):
                if time.time() >= job.expires_at or job.status in ("cancelled", "released", "expired"):
                    return
                timestamp = str(int(time.time()))
                headers = {"Content-Type": "application/json", "X-IQ-Timestamp": timestamp,
                           "X-IQ-Signature": signature(self.settings.secret, timestamp, raw)}
                try:
                    response = await client.post(self.settings.callback_url, content=raw, headers=headers)
                    if response.status_code == 200 and response.json().get("ok") is True:
                        return
                    if response.status_code in (400, 401, 403, 404):
                        break
                except (httpx.HTTPError, ValueError):
                    pass
                await asyncio.sleep(min(2 ** attempt, 30))
        # Cleanup loop retains a completed file only until its TTL; no permanent links.

    def remove_files(self, job: WorkerJob):
        job.token = ""
        directory = job_directory(self.root, job.id)
        shutil.rmtree(directory, ignore_errors=True)

    async def release(self, job_id: str, cancel=False):
        job = self.jobs.get(job_id)
        if not job:
            return
        if job.task and not job.task.done():
            job.task.cancel()
            try: await job.task
            except asyncio.CancelledError: pass
        self.remove_files(job)
        job.status = "cancelled" if cancel else "released"

    async def cleanup(self):
        now = time.time()
        for job in list(self.jobs.values()):
            if job.expires_at <= now:
                await self.release(job.id)
                job.status = "expired"
                if job.created_at + 86400 < now:
                    self.jobs.pop(job.id, None)
        for directory in self.root.iterdir():
            if not directory.is_symlink() and directory.is_dir() and directory.name not in self.jobs:
                if re.fullmatch(r"[0-9a-f-]{36}", directory.name):
                    shutil.rmtree(directory, ignore_errors=True)

    async def close(self):
        for job_id in list(self.jobs):
            await self.release(job_id)
