#!/usr/bin/env python3
"""Explicit operator command; credentials are read from environment, never logged."""
import argparse
import json
import os
import sys
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["check", "register"])
    args = parser.parse_args()
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    base = os.environ.get("APP_BASE_URL", "").rstrip("/")
    secret = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "")
    if not token or not base.startswith("https://"):
        raise ValueError("Set TELEGRAM_BOT_TOKEN and HTTPS APP_BASE_URL first.")
    def api(method, body):
        req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}",
                                     data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.load(response)
        if not data.get("ok"):
            raise RuntimeError("Telegram rejected the request; inspect configuration privately.")
        return data["result"]
    me = api("getMe", {})
    if me.get("username", "").lower() != "iqtlbot":
        raise ValueError("Token belongs to a different bot; no webhook changes made.")
    if args.action == "register":
        if not secret:
            raise ValueError("Set TELEGRAM_WEBHOOK_SECRET first.")
        api("setWebhook", {"url": base + "/telegramWebhook", "secret_token": secret,
                           "allowed_updates": ["message", "edited_message", "callback_query"],
                           "drop_pending_updates": False})
        api("setMyCommands", {"commands": [{"command": c, "description": d} for c, d in
              [("start", "Open IQ Media Downloader"), ("help", "How to download media"),
               ("history", "My Downloads"), ("settings", "Preferences"), ("admin", "Administrator tools")]]})
    info = api("getWebhookInfo", {})
    print(json.dumps({"bot": "@" + me["username"], "webhook_matches": info.get("url") == base + "/telegramWebhook",
                      "pending_update_count": info.get("pending_update_count"), "allowed_updates": info.get("allowed_updates"),
                      "last_error_date": info.get("last_error_date"), "has_error": bool(info.get("last_error_message"))}, indent=2))


if __name__ == "__main__":
    try: main()
    except Exception:
        print("Setup/check failed. Verify credentials, network and bot identity privately. No secrets were printed.", file=sys.stderr)
        sys.exit(1)
