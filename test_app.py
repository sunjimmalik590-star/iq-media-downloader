import asyncio
import json
import time
import uuid
import pytest
from fastapi.testclient import TestClient
from iq_worker.app import create_app
from iq_worker.config import Settings
from iq_worker.runner import JobRunner, WorkerJob, execute
from iq_worker.security import signature
from iq_worker.errors import MediaError


@pytest.fixture
def settings(tmp_path):
    return Settings(secret="TEST_ONLY_" + "x" * 40, public_url="https://worker.example.com", callback_url="https://bot.example.com/workerCallback", temp_root=tmp_path)


def signed(client, settings, path, payload):
    raw = json.dumps(payload).encode(); ts = str(int(time.time()))
    return client.post(path, content=raw, headers={"Content-Type": "application/json", "X-IQ-Timestamp": ts, "X-IQ-Signature": signature(settings.secret, ts, raw)})


def test_real_app_health_and_authentication(settings):
    with TestClient(create_app(settings)) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json() == {"status": "ok", "yt_dlp": True, "ffmpeg": True, "temp_writable": True}
        assert client.post("/health", json={}).status_code == 403
        assert signed(client, settings, "/health", {}).status_code == 200


def test_metadata_input_ssrf_and_extra_arguments_rejected(settings):
    with TestClient(create_app(settings)) as client:
        assert signed(client, settings, "/metadata", {"source_url": "http://127.0.0.1/a.mp4", "platform": "Direct", "max_file_size": 1000}).status_code == 422
        assert signed(client, settings, "/metadata", {"source_url": "https://example.com/a.mp4", "platform": "Direct", "max_file_size": 1000, "shell": "evil"}).status_code == 400


def download_payload(settings):
    return {"job_id": str(uuid.uuid4()), "source_url": "https://youtube.com/watch?v=fixture", "platform": "YouTube", "requested_format": "video", "requested_quality": "720p", "format_id": "a" * 24, "max_file_size": 100000, "max_redirects": 5, "timeout_ms": 300000, "callback_url": settings.callback_url}


def test_callback_destination_and_size_rejected(settings):
    with TestClient(create_app(settings)) as client:
        payload = download_payload(settings)
        assert signed(client, settings, "/download", {**payload, "callback_url": "https://evil.example/callback"}).status_code == 422
        assert signed(client, settings, "/download", {**payload, "max_file_size": settings.max_file_size + 1}).status_code == 422


def test_async_download_acceptance_and_duplicate_worker_job(settings, monkeypatch):
    async def waiting(*_args): await asyncio.sleep(30)
    monkeypatch.setattr(JobRunner, "run", waiting)  # MOCK download executor only for async API contract
    with TestClient(create_app(settings)) as client:
        payload = download_payload(settings)
        first = signed(client, settings, "/download", payload)
        assert first.status_code == 202 and first.json() == {"worker_job_id": payload["job_id"]}
        assert signed(client, settings, "/download", payload).json() == first.json()
        assert signed(client, settings, "/download", {**payload, "requested_quality": "360p"}).status_code == 422
        assert len(client.app.state.runner.jobs) == 1


def test_ephemeral_file_token_expiry_and_release(settings):
    with TestClient(create_app(settings)) as client:
        runner = client.app.state.runner; job_id = str(uuid.uuid4()); token = "t" * 43
        directory = settings.temp_root / job_id; directory.mkdir(); (directory / "media.mp4").write_bytes(b"test")
        job = WorkerJob(job_id, "fixture", "completed", time.time(), time.time() + 60, token=token, result={"filename": "media.mp4", "mime_type": "video/mp4"})
        runner.jobs[job_id] = job
        assert client.get(f"/files/{job_id}/bad").status_code == 404
        response = client.get(f"/files/{job_id}/{token}")
        assert response.status_code == 200 and response.content == b"test"
        assert "no-store" in response.headers["cache-control"]
        signed(client, settings, "/release", {"job_id": job_id})
        assert not directory.exists()
        assert client.get(f"/files/{job_id}/{token}").status_code == 404


def test_cleanup_deletes_expired_and_orphan_files(settings):
    async def run():
        runner = JobRunner(settings)
        job_id = str(uuid.uuid4()); directory = settings.temp_root / job_id; directory.mkdir(); (directory / "a").write_text("fixture")
        runner.jobs[job_id] = WorkerJob(job_id, "fixture", "completed", time.time() - 100, time.time() - 1)
        orphan = settings.temp_root / str(uuid.uuid4()); orphan.mkdir()
        await runner.cleanup()
        assert not directory.exists() and not orphan.exists()
    asyncio.run(run())


def test_subprocess_fails_safely_on_blocked_url():
    async def run():
        with pytest.raises(MediaError, match="BLOCKED_URL"):
            await execute({"operation": "metadata", "source_url": "http://127.0.0.1/file.mp4", "max_file_size": 1000}, 10)
    asyncio.run(run())
