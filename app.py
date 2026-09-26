import asyncio
import hmac
import importlib.util
import json
import shutil
import tempfile
import time
from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from .config import Settings
from .errors import MediaError
from .providers import detect
from .runner import JobRunner, job_directory
from .security import verify_signature


class MetadataRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_url: str = Field(max_length=4096)
    platform: str
    max_file_size: int = Field(gt=0)


class DownloadRequest(MetadataRequest):
    job_id: UUID
    requested_format: Literal["video", "audio"]
    requested_quality: str = Field(min_length=1, max_length=60)
    format_id: str = Field(pattern=r"^[0-9a-f]{24}$")
    max_redirects: int = Field(default=5, ge=0, le=5)
    timeout_ms: int = Field(default=300000, ge=1000, le=900000)
    callback_url: str


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: UUID


def create_app(settings: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        cfg = settings or Settings.load()
        runner = JobRunner(cfg)
        app.state.settings, app.state.runner = cfg, runner
        await runner.cleanup()
        async def sweeper():
            while True:
                await asyncio.sleep(15)
                await runner.cleanup()
        task = asyncio.create_task(sweeper())
        try:
            yield
        finally:
            task.cancel()
            try: await task
            except asyncio.CancelledError: pass
            await runner.close()

    app = FastAPI(title="IQ Media Downloader Worker", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def auth(request: Request, call_next):
        if request.method == "GET" and (request.url.path == "/health" or request.url.path.startswith("/files/")):
            return await call_next(request)
        if request.method != "POST":
            return JSONResponse({"error": "not_found"}, status_code=404)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 32768:
                return JSONResponse({"error": "body_too_large"}, status_code=413)
        cfg = request.app.state.settings
        if not verify_signature(cfg.secret, request.headers.get("X-IQ-Timestamp", ""), request.headers.get("X-IQ-Signature", ""), bytes(raw)):
            return JSONResponse({"error": "forbidden"}, status_code=403)
        try: request.state.payload = json.loads(raw)
        except ValueError: return JSONResponse({"error": "invalid_json"}, status_code=400)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(MediaError)
    async def media_error(_request, error):
        return JSONResponse({"error_code": error.code}, status_code=422)

    @app.exception_handler(ValidationError)
    async def validation_error(_request, _error):
        return JSONResponse({"error": "invalid_request"}, status_code=400)

    @app.get("/health")
    @app.post("/health")
    async def health(request: Request):
        writable = False
        try:
            with tempfile.TemporaryFile(dir=request.app.state.settings.temp_root) as f:
                f.write(b"ok")
            writable = True
        except OSError: pass
        yt = importlib.util.find_spec("yt_dlp") is not None
        ffmpeg = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
        return JSONResponse({"status": "ok" if yt and ffmpeg and writable else "degraded", "yt_dlp": yt,
                             "ffmpeg": ffmpeg, "temp_writable": writable}, status_code=200 if yt and ffmpeg and writable else 503,
                            headers={"Cache-Control": "no-store"})

    def validate_source(data: MetadataRequest, cfg: Settings):
        if detect(data.source_url) != data.platform:
            raise MediaError("UNSUPPORTED_LINK")
        if data.max_file_size > cfg.max_file_size:
            raise MediaError("MEDIA_TOO_LARGE")

    @app.post("/metadata")
    async def metadata(request: Request):
        data = MetadataRequest.model_validate(request.state.payload)
        validate_source(data, request.app.state.settings)
        return await request.app.state.runner.metadata(data.model_dump())

    @app.post("/download", status_code=202)
    async def download(request: Request):
        data = DownloadRequest.model_validate(request.state.payload)
        cfg = request.app.state.settings
        validate_source(data, cfg)
        if data.callback_url != cfg.callback_url:
            raise MediaError("BLOCKED_URL")
        payload = data.model_dump(mode="json")
        payload["timeout_ms"] = min(data.timeout_ms, cfg.max_timeout_ms)
        return {"worker_job_id": request.app.state.runner.submit(payload)}

    @app.post("/release")
    @app.post("/cancel")
    async def release(request: Request):
        data = JobRequest.model_validate(request.state.payload)
        await request.app.state.runner.release(str(data.job_id), request.url.path == "/cancel")
        return {"ok": True}

    @app.get("/files/{job_id}/{token}")
    async def result(request: Request, job_id: str, token: str):
        runner = request.app.state.runner
        job = runner.jobs.get(job_id)
        if not job or job.status != "completed" or time.time() >= job.expires_at or not job.result or not hmac.compare_digest(job.token, token):
            return JSONResponse({"error": "not_found"}, status_code=404)
        path = job_directory(runner.root, job_id) / job.result["filename"]
        if not path.is_file() or path.is_symlink():
            return JSONResponse({"error": "not_found"}, status_code=404)
        return FileResponse(path, media_type=job.result["mime_type"], filename=path.name,
                            headers={"Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"})
    return app


app = create_app()
