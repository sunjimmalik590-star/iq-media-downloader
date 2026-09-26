"""Real metadata, bounded native downloads, and local-only FFmpeg processing."""
import hashlib
import json
import math
import re
import subprocess
from pathlib import Path
from yt_dlp import YoutubeDL
from yt_dlp.downloader import get_suitable_downloader
from yt_dlp.downloader.http import HttpFD
from yt_dlp.downloader.dash import DashSegmentsFD
from yt_dlp.downloader.hls import HlsFD
from .security import SecureRH, validate_url
from .providers import detect
from .errors import MediaError


class QuietLogger:
    def debug(self, *_args, **_kwargs): pass
    def info(self, *_args, **_kwargs): pass
    def warning(self, *_args, **_kwargs): pass
    def error(self, *_args, **_kwargs): pass


class StrictHlsFD(HlsFD):
    def real_download(self, filename, info_dict):
        with self.ydl.urlopen(self._prepare_url(info_dict, info_dict["url"])) as response:
            manifest = response.read(2_000_001)
            final_url = response.url
        if len(manifest) > 2_000_000:
            raise MediaError("MEDIA_TOO_LARGE")
        text = manifest.decode("utf-8", errors="strict")
        if "#EXT-X-ENDLIST" not in text or "#EXT-X-KEY" in text or not self.can_download(text, info_dict, False):
            raise MediaError("FORMAT_UNAVAILABLE")
        # Preflight guarantees native support. No encryption, live stream or FFmpeg fallback.
        prepared = {**info_dict, "url": final_url, "hls_media_playlist_data": text}
        return super().real_download(filename, prepared)


class SafeYoutubeDL(YoutubeDL):
    def build_request_director(self, _handlers, _preferences=None):
        # Fail closed: no urllib/curl/requests fallback can bypass address validation.
        return super().build_request_director([SecureRH])

    def dl(self, name, info, subtitle=False, test=False):
        cls = get_suitable_downloader(info, self.params)
        if cls not in (HttpFD, DashSegmentsFD, HlsFD):
            raise MediaError("FORMAT_UNAVAILABLE")
        validate_url(info["url"])
        if cls is HlsFD:
            fd = StrictHlsFD(self, self.params)
            for hook in self._progress_hooks:
                fd.add_progress_hook(hook)
            prepared = self._copy_infodict(info)
            prepared.setdefault("http_headers", self._calc_headers(prepared))
            return fd.download(name, prepared, subtitle)
        return super().dl(name, info, subtitle=subtitle, test=test)


def ydl_options(maximum: int) -> dict:
    return {"quiet": True, "no_warnings": True, "logger": QuietLogger(), "noplaylist": True,
            "playlistend": 1, "skip_download": True, "socket_timeout": 20, "retries": 2,
            "fragment_retries": 2, "concurrent_fragment_downloads": 1, "max_filesize": maximum,
            "cachedir": False, "proxy": "", "geo_bypass": False, "usenetrc": False, "cookiefile": None,
            "cookiesfrombrowser": None, "enable_file_urls": False, "allow_unplayable_formats": False,
            "ignoreerrors": False, "overwrites": True, "continuedl": False,
            "hls_prefer_native": True, "external_downloader": {},
            "remote_components": set(), "js_runtimes": {"deno": {}}, "extractor_retries": 1,
            "http_headers": {"User-Agent": "Mozilla/5.0 (compatible; IQMediaDownloader/0.1)"}}


def file_size(f: dict) -> int | None:
    value = f.get("filesize") or f.get("filesize_approx")
    return int(value) if isinstance(value, (int, float)) and math.isfinite(value) and value > 0 else None


def usable(f: dict) -> bool:
    # Only native transports; HLS gets an additional unencrypted-VOD manifest preflight.
    return (bool(f.get("url")) and not f.get("has_drm") and
            f.get("protocol", "https") in ("http", "https", "http_dash_segments", "m3u8_native") and
            bool(re.fullmatch(r"[\w.-]{1,100}", str(f.get("format_id", "")), re.ASCII)) and
            f.get("ext") in ("mp4", "webm", "m4a", "mp3", "ogg", "opus", "wav", "aac", "mov", "mkv", "m4v"))


def choices(info: dict, maximum: int) -> list[dict]:
    if info.get("_type") in ("playlist", "multi_video") or info.get("entries") is not None:
        raise MediaError("UNSUPPORTED_LINK")
    if info.get("is_live") or info.get("live_status") == "is_live" or info.get("has_drm"):
        raise MediaError("UNSUPPORTED_LINK")
    formats = [f for f in info.get("formats", [info]) if usable(f)]
    audio = sorted([f for f in formats if f.get("acodec") != "none" and f.get("vcodec") == "none"], key=lambda f: f.get("abr") or f.get("tbr") or 0, reverse=True)
    selected: dict[tuple[str, str], dict] = {}

    def add(kind, quality, ext, parts, extraction=False):
        sizes = [file_size(f) for f in parts]
        size = sum(sizes) if all(sizes) else None
        if size and size > maximum:
            return
        identity = "|".join([kind, quality, ext, *(str(f["format_id"]) for f in parts)])
        record = {"id": hashlib.sha256(identity.encode()).hexdigest()[:24], "kind": kind, "quality": quality,
                  "ext": ext, "filesize": size, "parts": parts, "extract_audio": extraction}
        key = kind, quality
        old = selected.get(key)
        if old is None or sum(f.get("tbr") or 0 for f in parts) > sum(f.get("tbr") or 0 for f in old["parts"]):
            selected[key] = record

    for f in formats:
        if f.get("vcodec") == "none":
            continue
        height = f.get("height")
        quality = f"{int(height)}p" if isinstance(height, (int, float)) and height > 0 else str(f.get("format_note") or "Original")[:50]
        parts = [f]
        if f.get("acodec") == "none" and audio:
            compatible = [a for a in audio if a.get("ext") == "m4a"] if f["ext"] in ("mp4", "m4v") else audio
            parts += (compatible or audio)[:1]
        ext = "mp4" if f["ext"] in ("mp4", "m4v") and all(p["ext"] in ("mp4", "m4v", "m4a") for p in parts) else "mkv" if len(parts) > 1 else f["ext"]
        add("video", quality, ext, parts)
    sources = audio or sorted([f for f in formats if f.get("acodec") not in (None, "none")], key=lambda f: file_size(f) or maximum)
    if sources:
        f = sources[0]
        abr = f.get("abr")
        quality = f"Audio {round(abr)} kbps" if isinstance(abr, (int, float)) and abr > 0 else "Audio"
        # Audio is offered only when an actual audio stream exists. Conversion does not invent bitrate options.
        add("audio", quality, "m4a" if (f.get("acodec") or "").startswith(("mp4a", "aac")) else "mp3", [f], True)
    result = list(selected.values())
    result.sort(key=lambda f: (f["kind"] == "audio", -(int(f["quality"][:-1]) if re.fullmatch(r"\d+p", f["quality"]) else 0)))
    if not result:
        raise MediaError("FORMAT_UNAVAILABLE")
    return result[:20]


def normalize_metadata(info: dict, options: list[dict]) -> dict:
    duration = info.get("duration")
    return {"title": str(info.get("title") or "Media")[:300],
            "artist": str(info.get("artist") or info.get("uploader") or "")[:200],
            "duration": duration if isinstance(duration, (int, float)) and math.isfinite(duration) and duration >= 0 else None,
            "media_type": "video" if any(f["kind"] == "video" for f in options) else "audio",
            "formats": [{k: f[k] for k in ("id", "kind", "quality", "ext", "filesize")} for f in options]}


def extract(url: str, maximum: int):
    detect(url)
    SecureRH.max_response_bytes = maximum
    with SafeYoutubeDL(ydl_options(maximum)) as ydl:
        info = ydl.extract_info(url, download=False)
    if not isinstance(info, dict):
        raise MediaError("MEDIA_UNAVAILABLE")
    return info, choices(info, maximum)


def metadata(payload: dict) -> dict:
    info, options = extract(payload["source_url"], payload["max_file_size"])
    return normalize_metadata(info, options)


SAFE_DEMUXERS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,wav,ogg,aac,mpegts"


def probe(path: Path) -> dict:
    result = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", SAFE_DEMUXERS, "-show_streams", "-show_format", "-of", "json", str(path)],
                            shell=False, capture_output=True, timeout=25, check=True)
    info = json.loads(result.stdout)
    if not any(s.get("codec_type") in ("audio", "video") for s in info.get("streams", [])):
        raise MediaError("MEDIA_UNAVAILABLE")
    return info


def process_local(parts: list[Path], output: Path, choice: dict, maximum: int):
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    for p in parts:
        probe(p)
        cmd += ["-protocol_whitelist", "file,pipe", "-format_whitelist", SAFE_DEMUXERS, "-i", str(p)]
    if choice["kind"] == "audio":
        cmd += ["-map", "0:a:0", "-vn", "-c:a", "copy" if output.suffix == ".m4a" else "libmp3lame"]
    elif len(parts) > 1:
        cmd += ["-map", "0:v:0", "-map", "1:a:0", "-c", "copy"]
    else:
        cmd += ["-map", "0:v?", "-map", "0:a?", "-c", "copy"]
    if output.suffix in (".mp4", ".m4a"):
        cmd += ["-movflags", "+faststart"]
    # Do not use FFmpeg -fs: it can report success after silently truncating media.
    # The subprocess supervisor bounds disk usage and kills over-budget work.
    cmd += [str(output)]
    try:
        subprocess.run(cmd, shell=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120, check=True)
    except subprocess.CalledProcessError:
        if output.exists() and output.stat().st_size > maximum:
            raise MediaError("MEDIA_TOO_LARGE") from None
        raise
    if not output.is_file() or output.stat().st_size <= 0:
        raise MediaError("MEDIA_UNAVAILABLE")
    if output.stat().st_size > maximum:
        raise MediaError("MEDIA_TOO_LARGE")
    probe(output)


def download(payload: dict, directory: Path) -> dict:
    maximum = payload["max_file_size"]
    info, options = extract(payload["source_url"], maximum)
    choice = next((f for f in options if f["id"] == payload["format_id"] and f["kind"] == payload["requested_format"] and f["quality"] == payload["requested_quality"]), None)
    if not choice:
        raise MediaError("FORMAT_UNAVAILABLE")
    paths = []
    def progress(_event):
        if sum(p.stat().st_size for p in directory.glob("*") if p.is_file()) > maximum * 2 + 1_000_000:
            raise MediaError("MEDIA_TOO_LARGE")
    opts = ydl_options(maximum)
    opts.update({"skip_download": False, "progress_hooks": [progress], "nopart": False})
    with SafeYoutubeDL(opts) as ydl:
        for index, part in enumerate(choice["parts"]):
            target = directory / f"input-{index}.{part['ext']}"
            prepared = dict(part)
            prepared.setdefault("http_headers", info.get("http_headers", {}))
            result, _ = ydl.dl(str(target), prepared)
            if not result or not target.exists():
                raise MediaError("MEDIA_UNAVAILABLE")
            if target.stat().st_size > maximum:
                raise MediaError("MEDIA_TOO_LARGE")
            paths.append(target)
    output = directory / ("media." + choice["ext"])
    process_local(paths, output, choice, maximum)
    for path in paths:
        path.unlink(missing_ok=True)
    actual = probe(output)
    duration = actual.get("format", {}).get("duration")
    mime = {"mp4": "video/mp4", "m4v": "video/mp4", "webm": "video/webm", "mkv": "video/x-matroska", "mov": "video/quicktime", "m4a": "audio/mp4", "mp3": "audio/mpeg", "ogg": "audio/ogg", "opus": "audio/ogg", "wav": "audio/wav", "aac": "audio/aac"}[choice["ext"]]
    return {"filename": output.name, "mime_type": mime, "file_size": output.stat().st_size,
            "title": str(info.get("title") or "Media")[:300], "artist": str(info.get("artist") or info.get("uploader") or "")[:200],
            "duration": float(duration) if duration is not None else None}
