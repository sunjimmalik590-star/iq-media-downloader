from urllib.parse import urlsplit
from .errors import MediaError
from .security import validate_url

PROVIDERS = {
    "TikTok": ("tiktok.com",), "Instagram": ("instagram.com",),
    "Facebook": ("facebook.com", "fb.com", "fb.watch"),
    "YouTube": ("youtube.com", "youtu.be"), "X / Twitter": ("x.com", "twitter.com", "t.co"),
    "Reddit": ("reddit.com", "redd.it"), "Pinterest": ("pinterest.com", "pin.it"),
}


def detect(url: str) -> str:
    p, host, _ = validate_url(url)
    for platform, domains in PROVIDERS.items():
        if any(host == d or host.endswith("." + d) for d in domains):
            return platform
    if p.path.lower().endswith((".mp4", ".m4v", ".webm", ".mov", ".mkv", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav")):
        return "Direct"
    raise MediaError("UNSUPPORTED_LINK")
