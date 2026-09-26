"""Strict URL policy and a single yt-dlp transport with DNS pinning.

Every extractor request, manifest, fragment and redirect goes through this transport.
No default yt-dlp network handlers are retained. FFmpeg only opens local files.
"""
import hashlib
import hmac
import http.client
import ipaddress
import re
import socket
import ssl
import time
import urllib.request
from urllib.parse import urlsplit, urljoin, urlunsplit
from yt_dlp.networking.common import RequestHandler, Response
from yt_dlp.networking.exceptions import HTTPError, TransportError
from .errors import MediaError


def signature(secret: str, timestamp: str, body: bytes) -> str:
    return hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


def verify_signature(secret: str, timestamp: str, sig: str, body: bytes, now: float | None = None) -> bool:
    if not re.fullmatch(r"\d{10}", timestamp) or not re.fullmatch(r"[0-9a-f]{64}", sig):
        return False
    if abs(int(time.time() if now is None else now) - int(timestamp)) > 300:
        return False
    return hmac.compare_digest(signature(secret, timestamp, body), sig)


def public_ip(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
        if isinstance(ip, ipaddress.IPv6Address):
            if ip.ipv4_mapped or ip.sixtofour or ip.teredo:
                return False
            # Exclude NAT64 and translation prefixes too.
            if ip in ipaddress.ip_network("64:ff9b::/96") or ip in ipaddress.ip_network("64:ff9b:1::/48"):
                return False
        return ip.is_global and not ip.is_multicast and not ip.is_reserved
    except ValueError:
        return False


def validate_url(url: str):
    if len(url) > 8192 or re.search(r"[\x00-\x20\x7f\\]", url):
        raise MediaError("BLOCKED_URL")
    try:
        p = urlsplit(url)
        host = (p.hostname or "").rstrip(".").encode("idna").decode().lower()
        port = p.port or (443 if p.scheme == "https" else 80)
        if p.scheme not in ("http", "https") or p.username is not None or p.password is not None or port != (443 if p.scheme == "https" else 80):
            raise ValueError()
        if not host or host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".lan", ".home")) or "%" in host:
            raise ValueError()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if "." not in host or re.fullmatch(r"[0-9xXa-fA-F.]+", host):
                raise ValueError()
        else:
            if not public_ip(host):
                raise ValueError()
    except (ValueError, UnicodeError):
        raise MediaError("BLOCKED_URL") from None
    return p, host, port


def resolve_public(host: str, port: int, resolver=socket.getaddrinfo):
    try:
        records = resolver(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise MediaError("MEDIA_UNAVAILABLE") from None
    if not records or any(not public_ip(record[4][0]) for record in records):
        raise MediaError("BLOCKED_URL")
    return records


def pinned_connection(url: str, timeout: float):
    p, host, port = validate_url(url)
    records = resolve_public(host, port)
    last_error = None
    for family, socktype, proto, _, address in records:
        sock = socket.socket(family, socktype, proto)
        sock.settimeout(timeout)
        try:
            # connect receives a vetted numeric sockaddr, never a hostname or second DNS lookup.
            sock.connect(address)
            if not public_ip(sock.getpeername()[0]):
                raise MediaError("BLOCKED_URL")
            if p.scheme == "https":
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
            conn = http.client.HTTPConnection(host, port, timeout=timeout)
            conn.sock = sock
            return conn
        except Exception as error:
            sock.close()
            last_error = error
    if isinstance(last_error, MediaError):
        raise last_error
    raise MediaError("MEDIA_UNAVAILABLE")


class CappedReader:
    def __init__(self, response, connection, maximum):
        self.response, self.connection, self.maximum, self.read_bytes = response, connection, maximum, 0
        self.closed = False

    def read(self, size=-1):
        remaining = self.maximum - self.read_bytes
        data = self.response.read(min(size if size is not None and size >= 0 else remaining + 1, remaining + 1))
        self.read_bytes += len(data)
        if self.read_bytes > self.maximum:
            self.close()
            raise TransportError("MEDIA_TOO_LARGE")
        return data

    def close(self):
        self.closed = True
        self.response.close()
        self.connection.close()

    def readable(self):
        return True


class SecureRH(RequestHandler):
    _SUPPORTED_URL_SCHEMES = ("https", "http")
    _SUPPORTED_PROXY_SCHEMES = ()
    max_redirects = 5
    max_response_bytes = 64_000_000
    connector = staticmethod(pinned_connection)

    def _check_extensions(self, extensions):
        super()._check_extensions(extensions)
        for key in ("cookiejar", "timeout", "keep_header_casing"):
            extensions.pop(key, None)

    def _send(self, request):
        url, method, body = request.url, request.method, request.data
        headers = self._get_headers(request)
        # Disable compression to maintain bounded, transparent streaming.
        for key in list(headers):
            if key.lower() in ("host", "authorization", "proxy-authorization", "accept-encoding"):
                del headers[key]
        headers["Accept-Encoding"] = "identity"
        jar = self._get_cookiejar(request)
        try:
            for redirect in range(self.max_redirects + 1):
                p, _, _ = validate_url(url)
                connection = self.connector(url, self._calculate_timeout(request))
                cookie_request = urllib.request.Request(url, headers=headers)
                jar.add_cookie_header(cookie_request)
                sent_headers = dict(cookie_request.header_items())
                path = urlunsplit(("", "", p.path or "/", p.query, ""))
                connection.request(method, path, body=body, headers=sent_headers)
                response = connection.getresponse()
                jar.extract_cookies(response, cookie_request)
                if response.status in (301, 302, 303, 307, 308) and response.getheader("Location"):
                    location = urljoin(url, response.getheader("Location"))
                    response.close()
                    connection.close()
                    if redirect == self.max_redirects:
                        raise MediaError("BLOCKED_URL")
                    validate_url(location)
                    # Do not forward origin cookies on a redirect; cookiejar scopes public cookies.
                    headers = {k: v for k, v in headers.items() if k.lower() not in ("cookie", "authorization")}
                    if response.status == 303 or (response.status in (301, 302) and method == "POST"):
                        method, body = "GET", None
                    url = location
                    continue
                if int(response.getheader("Content-Length", "0")) > self.max_response_bytes:
                    response.close(); connection.close()
                    raise MediaError("MEDIA_TOO_LARGE")
                wrapped = Response(CappedReader(response, connection, self.max_response_bytes), url,
                                   response.headers, response.status, response.reason)
                if response.status >= 400:
                    raise HTTPError(wrapped)
                return wrapped
        except MediaError as error:
            raise TransportError(error.code) from None
        except (OSError, http.client.HTTPException, ValueError):
            raise TransportError("MEDIA_UNAVAILABLE") from None
        raise TransportError("BLOCKED_URL")
