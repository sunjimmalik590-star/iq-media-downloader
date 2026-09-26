import os
import uvicorn

if __name__ == "__main__":
    # Single process owns the job registry/semaphore; do not increase uvicorn workers.
    uvicorn.run("iq_worker.app:app", host="0.0.0.0", port=int(os.environ.get("PORT", "10000")),
                workers=1, access_log=False, log_level="warning", proxy_headers=False)
