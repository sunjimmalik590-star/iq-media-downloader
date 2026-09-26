import hashlib
import hmac
import io
import socket
import time
from http.client import HTTPResponse
import pytest
from yt_dlp.networking.common import Request
from yt_dlp.networking.exceptions import TransportError
from iq_worker.security import signature, verify_signature, public_ip, validate_url, resolve_public, SecureRH
from iq_worker.errors import MediaError
from iq_worker.media import QuietLogger
from iq_worker.runner import job_directory


def test_cross_language_hmac_vector():
    expected = hmac.new(b"test-secret", b'1700000000.{"a":1}', hashlib.sha256).hexdigest()
    assert expected == "8cb2c3355fca388e9ac2caec004f4d5d7045d74937ab5faad61dc11682247a9f"
    assert signature("test-secret", "1700000000", b'{"a":1}') == expected


def test_hmac_authentication():
    now = int(time.time()); ts = str(now); raw = b'{"a":1}'
    sig = signature("test", ts, raw)
    assert verify_signature("test", ts, sig, raw, now)
    assert not verify_signature("test", ts, sig, raw + b" ", now)
    assert not verify_signature("test", ts, sig, raw, now + 301)
    assert not verify_signature("test", ts, sig, raw, now - 301)
    assert not verify_signature("test", ts, "f" * 64, raw, now)
    assert not verify_signature("test", ts, sig.upper(), raw, now)


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1"])
def test_private_special_addresses_blocked(ip):
    assert not public_ip(ip)


@pytest.mark.parametrize("url", ["http://localhost/", "http://127.1/", "http://2130706433/", "http://0x7f000001/", "https://user:pass@youtube.com/", "file:///etc/passwd", "ftp://youtube.com/x", "https://youtube.com:8443/x", "https://metadata.google.internal/", "http://[::1]/", "http://[fe80::1%25eth0]/", "https://youtube.com\\@example.com/", "https://youtube.com/\n"])
def test_unsafe_urls(url):
    with pytest.raises(MediaError): validate_url(url)


def test_dns_rebinding_mixed_answers_rejected():
    resolver = lambda *_args, **_kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)), (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
    with pytest.raises(MediaError, match="BLOCKED_URL"): resolve_public("public.example", 443, resolver)


def test_public_dns_answers_accepted():
    resolver = lambda *_args, **_kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
    assert resolve_public("public.example", 443, resolver)


class FakeSocket:
    def __init__(self, data): self.data = io.BytesIO(data)
    def makefile(self, *_args): return self.data


class MockHTTPConnection:
    """Explicitly mocked outbound HTTP transport; never production networking."""
    def __init__(self, body=b"OK", status=200, headers=None):
        headers = headers or {"Content-Length": str(len(body))}
        raw = f"HTTP/1.1 {status} Test\r\n".encode() + b"".join(f"{k}: {v}\r\n".encode() for k, v in headers.items()) + b"\r\n" + body
        self.response = HTTPResponse(FakeSocket(raw)); self.response.begin()
    def request(self, *_args, **_kwargs): pass
    def getresponse(self): return self.response
    def close(self): self.response.close()


def test_redirect_ssrf_blocked_before_connect(monkeypatch):
    calls = []
    def connector(url, _timeout):
        calls.append(url)
        return MockHTTPConnection(status=302, headers={"Location": "http://169.254.169.254/latest", "Content-Length": "0"})
    monkeypatch.setattr(SecureRH, "connector", staticmethod(connector))
    with pytest.raises(TransportError, match="BLOCKED_URL"):
        SecureRH(logger=QuietLogger()).send(Request("https://public.example/test"))
    assert len(calls) == 1


def test_redirect_hop_limit(monkeypatch):
    calls = []
    def connector(url, _timeout):
        calls.append(url)
        return MockHTTPConnection(status=302, headers={"Location": "/next", "Content-Length": "0"})
    monkeypatch.setattr(SecureRH, "connector", staticmethod(connector))
    with pytest.raises(TransportError, match="BLOCKED_URL"):
        SecureRH(logger=QuietLogger()).send(Request("https://public.example/test"))
    assert len(calls) == 6


def test_transport_response_limit(monkeypatch):
    monkeypatch.setattr(SecureRH, "connector", staticmethod(lambda *_: MockHTTPConnection(body=b"12345")))
    monkeypatch.setattr(SecureRH, "max_response_bytes", 4)
    with pytest.raises(TransportError, match="MEDIA_TOO_LARGE"):
        SecureRH(logger=QuietLogger()).send(Request("https://public.example/file"))


def test_path_traversal_and_symlink(tmp_path):
    with pytest.raises(MediaError): job_directory(tmp_path, "../../etc")
    job = "00000000-0000-0000-0000-000000000001"
    (tmp_path / job).symlink_to("/tmp")
    with pytest.raises(MediaError): job_directory(tmp_path, job)
