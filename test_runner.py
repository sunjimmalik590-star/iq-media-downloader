"""Runner contract tests. Network and download executor doubles are explicitly mocked."""
import asyncio
import json
import time
import uuid
import httpx
import pytest
from iq_worker.config import Settings
from iq_worker.runner import JobRunner, WorkerJob
from iq_worker.security import verify_signature
from iq_worker.errors import MediaError
import iq_worker.runner as runner_module


def cfg(tmp_path):
    return Settings(secret="TEST_ONLY_" + "x" * 40, public_url="https://worker.example.com", callback_url="https://bot.example.com/workerCallback", temp_root=tmp_path)


def test_real_callback_signing_with_mock_http_response(tmp_path, monkeypatch):
    config = cfg(tmp_path)
    observed = []
    async def handle(request):
        body = request.content
        assert str(request.url) == config.callback_url
        assert verify_signature(config.secret, request.headers["X-IQ-Timestamp"], request.headers["X-IQ-Signature"], body)
        observed.append(json.loads(body))
        return httpx.Response(200, json={"ok": True})
    original = httpx.AsyncClient
    monkeypatch.setattr(runner_module.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs))
    async def run():
        runner = JobRunner(config)
        job = WorkerJob(str(uuid.uuid4()), "fixture", "completed", time.time(), time.time() + 60)
        payload = {"job_id": job.id, "status": "failed", "error_code": "MEDIA_UNAVAILABLE"}
        await runner.callback(payload, job)
        assert observed == [payload]
    asyncio.run(run())


def test_runner_failure_callback_and_file_cleanup(tmp_path, monkeypatch):
    async def fail(payload, *_args):
        from pathlib import Path
        (Path(payload["directory"]) / "partial.mp4").write_bytes(b"partial")
        raise MediaError("DOWNLOAD_TIMEOUT")
    monkeypatch.setattr(runner_module, "execute", fail)
    observed = []
    async def callback(_self, payload, _job): observed.append(payload)
    monkeypatch.setattr(JobRunner, "callback", callback)
    async def run():
        runner = JobRunner(cfg(tmp_path)); job_id = str(uuid.uuid4())
        runner.submit({"job_id": job_id, "max_file_size": 10000, "timeout_ms": 1000})
        await runner.jobs[job_id].task
        assert runner.jobs[job_id].status == "failed"
        assert observed[0]["error_code"] == "DOWNLOAD_TIMEOUT"
        assert not (tmp_path / job_id).exists()
    asyncio.run(run())


def test_runner_success_retains_short_lived_file_until_release(tmp_path, monkeypatch):
    async def fixture_result(payload, *_args):
        from pathlib import Path
        (Path(payload["directory"]) / "media.mp4").write_bytes(b"fixture")
        return {"filename": "media.mp4", "file_size": 7, "mime_type": "video/mp4", "title": "MOCK", "artist": "", "duration": 1}
    monkeypatch.setattr(runner_module, "execute", fixture_result)
    observed = []
    async def callback(_self, payload, _job): observed.append(payload)
    monkeypatch.setattr(JobRunner, "callback", callback)
    async def run():
        runner = JobRunner(cfg(tmp_path)); job_id = str(uuid.uuid4())
        runner.submit({"job_id": job_id, "max_file_size": 10000, "timeout_ms": 1000})
        await runner.jobs[job_id].task
        assert observed[0]["status"] == "completed"
        assert f"/files/{job_id}/" in observed[0]["file_url"]
        assert len(runner.jobs[job_id].token) == 43
        assert (tmp_path / job_id / "media.mp4").exists()
        await runner.release(job_id)
        assert not (tmp_path / job_id).exists() and not runner.jobs[job_id].token
    asyncio.run(run())


def test_worker_concurrency_limit(tmp_path, monkeypatch):
    active = 0; peak = 0
    async def task(_payload, *_args):
        nonlocal active, peak
        active += 1; peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        raise MediaError("MEDIA_UNAVAILABLE")
    monkeypatch.setattr(runner_module, "execute", task)
    async def callback(*_args): pass
    monkeypatch.setattr(JobRunner, "callback", callback)
    async def run():
        from dataclasses import replace
        runner = JobRunner(replace(cfg(tmp_path), concurrency=2))
        for _ in range(5): runner.submit({"job_id": str(uuid.uuid4()), "max_file_size": 10000, "timeout_ms": 1000})
        await asyncio.gather(*(j.task for j in runner.jobs.values()))
        assert peak == 2
    asyncio.run(run())
