#!/usr/bin/env python3
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.request

try:
    base = os.environ["DOWNLOAD_WORKER_URL"].rstrip("/")
    secret = os.environ["DOWNLOAD_WORKER_SECRET"]
    if not base.startswith("https://"): raise ValueError()
    ts = str(int(time.time())); raw = b"{}"
    sig = hmac.new(secret.encode(), ts.encode() + b"." + raw, hashlib.sha256).hexdigest()
    req = urllib.request.Request(base + "/health", data=raw, headers={"Content-Type": "application/json", "X-IQ-Timestamp": ts, "X-IQ-Signature": sig})
    with urllib.request.urlopen(req, timeout=90) as response:
        data = json.load(response)
    print(json.dumps({k: data.get(k) for k in ("status", "yt_dlp", "ffmpeg", "temp_writable")}, indent=2))
except Exception:
    print("Signed worker health check failed; check service and secret configuration privately.", file=sys.stderr)
    sys.exit(1)
