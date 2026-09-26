class MediaError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def classify_error(error: Exception) -> str:
    if isinstance(error, MediaError):
        return error.code
    text = str(error).lower()
    for code in ("PRIVATE_CONTENT", "MEDIA_UNAVAILABLE", "MEDIA_TOO_LARGE", "FORMAT_UNAVAILABLE", "DOWNLOAD_TIMEOUT", "UNSUPPORTED_LINK", "BLOCKED_URL"):
        if code.lower() in text:
            return code
    if "blocked_url" in text:
        return "BLOCKED_URL"
    if any(s in text for s in ("private", "login", "sign in", "not a bot", "cookies", "members-only", "age-restricted")):
        return "PRIVATE_CONTENT"
    if "timed out" in text or "timeout" in text:
        return "DOWNLOAD_TIMEOUT"
    if "format" in text and "available" in text:
        return "FORMAT_UNAVAILABLE"
    if "too large" in text or "max-filesize" in text:
        return "MEDIA_TOO_LARGE"
    return "MEDIA_UNAVAILABLE"
