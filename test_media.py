import json
import subprocess
from pathlib import Path
import pytest
from yt_dlp.networking.exceptions import TransportError
from iq_worker.media import choices, normalize_metadata, process_local, probe, metadata, download, SafeYoutubeDL, ydl_options, StrictHlsFD, QuietLogger
from iq_worker.security import SecureRH
from iq_worker.errors import MediaError
from iq_worker.providers import detect
from test_security import MockHTTPConnection


def format_fixture(**overrides):
    return {"format_id": "18", "url": "https://cdn.example.com/v.mp4", "ext": "mp4", "protocol": "https", "height": 720, "vcodec": "avc1", "acodec": "mp4a.40.2", "filesize": 1000, **overrides}


def test_metadata_actual_formats_only():
    info = {"title": "Fixture", "duration": 32, "formats": [format_fixture()]}
    m = normalize_metadata(info, choices(info, 10000))
    assert m["formats"][0]["quality"] == "720p"
    assert len(m["formats"]) == 2
    assert "360p" not in json.dumps(m) and "1080p" not in json.dumps(m)
    assert all("parts" not in f for f in m["formats"])


def test_no_fabricated_audio_for_silent_video():
    result = choices({"formats": [format_fixture(acodec="none")]}, 10000)
    assert [f["kind"] for f in result] == ["video"]


def test_direct_generic_unknown_codec_is_original_video():
    result = choices({"formats": [format_fixture(vcodec=None, acodec=None, height=None)]}, 10000)
    assert result[0]["quality"] == "Original"
    assert len(result) == 1


def test_merge_uses_real_video_and_audio_ids():
    info = {"formats": [format_fixture(acodec="none"), format_fixture(format_id="140", ext="m4a", vcodec="none", height=None)]}
    result = choices(info, 10000)
    assert [f["format_id"] for f in result[0]["parts"]] == ["18", "140"]


@pytest.mark.parametrize("info", [{"is_live": True}, {"has_drm": True}, {"_type": "playlist", "entries": []}, {"formats": [format_fixture(protocol="rtmp")]}, {"formats": [format_fixture(has_drm=True)]}])
def test_unsupported_media_fails_closed(info):
    with pytest.raises(MediaError): choices(info, 10000)


def test_oversized_formats_are_not_offered():
    with pytest.raises(MediaError): choices({"formats": [format_fixture(filesize=50000)]}, 100)


@pytest.mark.parametrize("host,platform", [("tiktok.com", "TikTok"), ("instagram.com", "Instagram"), ("facebook.com", "Facebook"), ("youtu.be", "YouTube"), ("twitter.com", "X / Twitter"), ("redd.it", "Reddit"), ("pin.it", "Pinterest"), ("cdn.example.com/a.mp4", "Direct")])
def test_platform_detection(host, platform):
    assert detect("https://" + host) == platform


@pytest.fixture
def real_clip(tmp_path):
    path = tmp_path / "fixture.mp4"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", str(path)], check=True, shell=False)
    return path


@pytest.mark.media
def test_real_local_ffmpeg_remux_and_audio_extraction(real_clip, tmp_path):
    output = tmp_path / "remux.mp4"
    process_local([real_clip], output, {"kind": "video"}, 1_000_000)
    assert output.stat().st_size > 0 and probe(output)["streams"][0]["codec_type"] == "video"
    audio = tmp_path / "audio.m4a"
    process_local([real_clip], audio, {"kind": "audio"}, 1_000_000)
    assert all(s["codec_type"] == "audio" for s in probe(audio)["streams"])


@pytest.mark.media
def test_real_ytdlp_and_ffmpeg_with_mock_public_http_source(real_clip, tmp_path, monkeypatch):
    data = real_clip.read_bytes()
    requests = []
    def connector(url, _timeout):
        assert url == "https://cdn.example.com/fixture.mp4"
        requests.append(url)
        return MockHTTPConnection(body=data, headers={"Content-Type": "video/mp4", "Content-Length": str(len(data))})
    monkeypatch.setattr(SecureRH, "connector", staticmethod(connector))
    source = {"source_url": "https://cdn.example.com/fixture.mp4", "platform": "Direct", "max_file_size": 1_000_000}
    m = metadata(source)
    assert m["formats"] and m["formats"][0]["quality"] == "Original"
    directory = tmp_path / "download"
    directory.mkdir()
    f = m["formats"][0]
    result = download({**source, "format_id": f["id"], "requested_format": f["kind"], "requested_quality": f["quality"]}, directory)
    assert result["mime_type"] == "video/mp4" and result["file_size"] > 0
    assert (directory / result["filename"]).is_file()
    assert len(requests) >= 3


def test_only_security_transport_registered():
    with SafeYoutubeDL(ydl_options(1_000_000)) as ydl:
        assert set(ydl._request_director.handlers) == {"Secure"}


def test_fake_media_rejected_by_actual_ffprobe(tmp_path):
    file = tmp_path / "malicious.mp4"; file.write_text("<html>not video</html>")
    with pytest.raises(subprocess.CalledProcessError): probe(file)


@pytest.mark.media
def test_processed_oversized_file_fails_instead_of_returning_truncated_success(real_clip, tmp_path):
    with pytest.raises(MediaError, match="MEDIA_TOO_LARGE"):
        process_local([real_clip], tmp_path / "too-big.mp4", {"kind": "video"}, 1000)
