FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PORT=10000
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 iq \
    && mkdir -p /tmp/iq /app && chown iq:iq /tmp/iq /app
WORKDIR /app
COPY worker/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir -r requirements.lock
COPY --chown=iq:iq worker/iq_worker /app/iq_worker
USER iq
EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "iq_worker.serve"]
