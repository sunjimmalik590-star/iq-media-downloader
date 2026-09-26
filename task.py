"""One subprocess per extraction/download: hard timeouts kill FFmpeg descendants too."""
import json
import os
import resource
import sys
from pathlib import Path
from .media import metadata, download
from .errors import classify_error
from .security import SecureRH


def main():
    payload = json.load(sys.stdin)
    maximum = int(payload["max_file_size"])
    SecureRH.max_redirects = min(int(payload.get("max_redirects", 5)), 5)
    resource.setrlimit(resource.RLIMIT_FSIZE, (maximum * 3, maximum * 3))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # A child cannot access the service HMAC secret or any Telegram credential.
    for key in list(os.environ):
        if any(marker in key for marker in ("SECRET", "TOKEN", "PASSWORD", "API_KEY")):
            os.environ.pop(key, None)
    try:
        result = metadata(payload) if payload["operation"] == "metadata" else download(payload, Path(payload["directory"]))
        print(json.dumps({"ok": True, "result": result}, allow_nan=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error_code": classify_error(error)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
