import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


def positive(name: str, default: int, minimum: int = 1, maximum: int = 1_000_000_000) -> int:
    value = int(os.environ.get(name, str(default)))
    if not minimum <= value <= maximum:
        raise ValueError(f"Invalid {name}")
    return value


@dataclass(frozen=True)
class Settings:
    secret: str
    public_url: str
    callback_url: str
    temp_root: Path = Path("/tmp/iq")
    concurrency: int = 5
    max_file_size: int = 47_185_920
    ttl: int = 900
    max_jobs: int = 20
    max_timeout_ms: int = 300_000
    metadata_timeout: int = 90

    @classmethod
    def load(cls):
        secret = os.environ.get("DOWNLOAD_WORKER_SECRET", "")
        public = os.environ.get("PUBLIC_WORKER_URL", "").rstrip("/")
        callback = os.environ.get("CALLBACK_BASE_URL", "").rstrip("/")
        if len(secret) < 32:
            raise ValueError("DOWNLOAD_WORKER_SECRET must have at least 32 characters")
        for url in (public, callback):
            p = urlsplit(url)
            if p.scheme != "https" or not p.hostname or p.username or p.password or p.port not in (None, 443) or p.path or p.query or p.fragment:
                raise ValueError("Service origins must be HTTPS origins")
        return cls(secret=secret, public_url=public, callback_url=callback + "/workerCallback",
                   concurrency=positive("MAX_CONCURRENT_JOBS", 5, 1, 20),
                   max_file_size=positive("MAX_FILE_SIZE", 47_185_920),
                   ttl=positive("TEMP_FILE_TTL", 900, 60, 86400),
                   max_jobs=positive("MAX_QUEUED_JOBS", 20, 1, 100),
                   max_timeout_ms=positive("DOWNLOAD_TIMEOUT_MS", 300000, 1000, 900000))
