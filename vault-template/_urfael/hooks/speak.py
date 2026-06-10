#!/usr/bin/env python3
"""Urfael voice-out. Claude Code `Stop` hook: speaks the final assistant message via local macOS `say` by default (or
cloud TTS: ElevenLabs/OpenAI). Scoped to the Urfael vault.

Reads its key/config from ~/.claude/urfael/tts.env (KEY=VALUE lines). If no key is
present it exits silently — so the vault still works without voice. Never blocks Claude:
all errors are swallowed and it always exits 0.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

CONFIG = Path.home() / ".claude" / "urfael" / "tts.env"
MAX_CHARS = 600  # keep spoken replies short + cheap


def load_config() -> dict:
    cfg = {}
    if CONFIG.exists():
        for line in CONFIG.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip().strip('"').strip("'")
    return cfg


def last_assistant_text(transcript_path: str) -> str:
    text = ""
    try:
        with open(transcript_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") != "assistant":
                    continue
                content = entry.get("message", {}).get("content", [])
                parts = [b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text"]
                if parts:
                    text = "\n".join(parts)  # keep only the latest assistant turn
    except OSError:
        return ""
    return text


def clean_for_speech(text: str) -> str:
    m = re.search(r"\[SPOKEN\](.*?)\[/SPOKEN\]", text, re.S | re.I)  # speak only the [SPOKEN] comment
    if m:
        text = m.group(1)
    text = re.sub(r"\[/?SPOKEN\]", " ", text, flags=re.I)
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)   # code blocks
    text = re.sub(r"`[^`]*`", " ", text)                       # inline code
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)     # links -> label
    text = re.sub(r"https?://\S+", " ", text)                  # bare urls
    text = re.sub(r"[#>*_~|`\\-]", " ", text)                  # md punctuation
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > MAX_CHARS:
        cut = text[:MAX_CHARS]
        end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        text = cut[: end + 1] if end > 0 else cut
    return text


def synth_openai(text: str, cfg: dict) -> bytes | None:
    key = cfg.get("OPENAI_API_KEY")
    if not key:
        return None
    body = json.dumps({
        "model": cfg.get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
        "voice": cfg.get("TTS_VOICE", "ash"),
        "input": text,
        "response_format": "mp3",
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/audio/speech", data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def synth_elevenlabs(text: str, cfg: dict) -> bytes | None:
    key = cfg.get("ELEVENLABS_API_KEY")
    voice_id = cfg.get("TTS_VOICE_ID")
    if not key or not voice_id:
        return None
    try:
        speed = float(cfg.get("ELEVENLABS_SPEED", "1.0"))
    except ValueError:
        speed = 1.0
    body = json.dumps({
        "text": text,
        "model_id": cfg.get("ELEVENLABS_TTS_MODEL", "eleven_turbo_v2_5"),
        "voice_settings": {"stability": 0.85, "similarity_boost": 0.9, "style": 0.0,
                           "use_speaker_boost": True, "speed": speed},
    }).encode()
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}", data=body,
        headers={"xi-api-key": key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def speak_say(text: str, cfg: dict) -> None:
    # macOS `say` — local, free, no API. Plays directly (detached) and returns.
    args = ["/usr/bin/say"]
    if cfg.get("SAY_VOICE"):
        args += ["-v", cfg["SAY_VOICE"]]
    if cfg.get("SAY_RATE"):
        args += ["-r", str(cfg["SAY_RATE"])]
    args.append(text)
    subprocess.Popen(args, start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def synth_kokoro(text: str, cfg: dict):  # local Kokoro-FastAPI (no auth) -> mp3 bytes
    body = json.dumps({"model": "kokoro", "voice": cfg.get("KOKORO_VOICE", "bm_george"),
                       "input": text, "response_format": "mp3"}).encode()
    req = urllib.request.Request(cfg.get("KOKORO_URL", "http://localhost:8880/v1/audio/speech"),
                                 data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def main() -> None:
    if os.environ.get("URFAEL_OVERLAY"):
        return  # the desktop overlay does its own TTS; don't double-speak via afplay
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return
    transcript = payload.get("transcript_path")
    if not transcript:
        return
    cfg = load_config()
    text = clean_for_speech(last_assistant_text(transcript))
    if not text:
        return
    provider = cfg.get("TTS_PROVIDER", "say").lower()   # local `say` is the default — no API key needed
    if provider == "say":
        speak_say(text, cfg)
        return
    try:
        if provider == "kokoro":
            audio = synth_kokoro(text, cfg)
        elif provider == "elevenlabs":
            audio = synth_elevenlabs(text, cfg)
        else:
            audio = synth_openai(text, cfg)
    except Exception:
        return  # network/auth issues must never break the session
    if not audio:
        return
    tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
    tmp.write(audio)
    tmp.close()
    # detached playback: don't block Claude, survive this process exiting. quote the path so a
    # space/metachar in TMPDIR can never break out of the shell command.
    q = shlex.quote(tmp.name)
    subprocess.Popen(["/bin/sh", "-c", f"afplay {q}; rm -f {q}"],
                     start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
