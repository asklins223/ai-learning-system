#!/usr/bin/env python3
"""edge-tts HTTP 服务（Docker 容器内运行）。

暴露 OpenAI 协议端点，供 apps/api 经 http://edge-tts:8080 调用：

  POST /v1/audio/speech
    body: { "model": "edge-tts", "input": "<文本>", "voice": "zh-CN-XiaoxiaoNeural", "rate": "+0%" }
    resp: audio/mpeg（mp3 字节）
    err : { "error": { "message": "...", "type": "..." } } + 4xx/5xx

  GET /v1/models
    resp: { "object": "list", "data": [ { "id": "<voice>", "object": "model", "owned_by": "edge-tts" } ] }

  GET /health
    resp: { "ok": true, "voices": <n> }

约束：
- 与 voice-service 的 assertSafeTtsInput 对齐：拒绝 SSML 标签、URL、
  脚本标记（服务端已做第一道，此处防御性第二道）；
- 单请求文本长度上限 2000 字符；
- 并发合成用线程池（edge-tts 每次合成是独立 HTTPS 会话）。
"""

import asyncio
import json
import os
import re
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import edge_tts

MAX_INPUT_LEN = 2000
SSML_RE = re.compile(r"<[^>]*>")
URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
SCRIPT_RE = re.compile(r"<script|javascript:|onerror=|onload=", re.IGNORECASE)

# 常用中文 voice（按需扩展；完整列表见 GET /v1/models）
DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"

# 共享鉴权头（security_review MEDIUM：内网组件被攻破时防止任意调用/放大）。
# 由 compose 注入 EDGE_TTS_AUTH_TOKEN；未配置 → fail closed（拒绝一切请求）。
AUTH_TOKEN = os.environ.get("EDGE_TTS_AUTH_TOKEN", "")

_pool = ThreadPoolExecutor(max_workers=4)

# models 缓存（voice 列表稳定；避免每次请求实时 list_voices 放大外部调用）
_models_cache = {"ts": 0.0, "data": None}
_MODELS_CACHE_TTL_S = 3600


def _list_voices_cached():
    import time

    now = time.time()
    if _models_cache["data"] is not None and now - _models_cache["ts"] < _MODELS_CACHE_TTL_S:
        return _models_cache["data"]
    # edge-tts 6.x 的 list_voices() 是 async（review should-fix 修复）
    voices = asyncio.run(edge_tts.list_voices())
    data = voices if isinstance(voices, list) else []
    _models_cache["ts"] = now
    _models_cache["data"] = data
    return data


def _synthesize(input_text: str, voice: str, rate: str) -> bytes:
    """同步合成（在 executor 中运行；edge-tts 6.x 为同步 API）。"""
    text = input_text.strip()
    if not text:
        raise ValueError("empty input")
    if len(text) > MAX_INPUT_LEN:
        raise ValueError(f"input too long (>{MAX_INPUT_LEN})")
    if SSML_RE.search(text) or URL_RE.search(text) or SCRIPT_RE.search(text):
        raise ValueError("unsafe input (SSML/URL/script markers not allowed)")

    communicate = edge_tts.Communicate(text, voice=voice, rate=rate or "+0%")

    async def _run() -> bytes:
        chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        if not chunks:
            raise RuntimeError("no audio produced")
        return b"".join(chunks)

    return asyncio.run(_run())


def _json_err(status: int, message: str, err_type: str = "invalid_request_error") -> bytes:
    body = json.dumps({"error": {"message": message, "type": err_type}}).encode("utf-8")
    return body


class Handler(BaseHTTPRequestHandler):
    server_version = "edge-tts/1.0"

    def log_message(self, fmt, *args):  # 静默访问日志（容器内由 compose 收集）
        pass

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        """共享 secret 校验（security_review MEDIUM）：未配置 token → fail closed。"""
        if not AUTH_TOKEN:
            return False
        header = self.headers.get("X-Edge-TTS-Token", "")
        return header == AUTH_TOKEN

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        # /health 豁免鉴权（security_review MEDIUM 修复）：健康检查不带 token，
        # 只返回 ok/voices 数，不暴露敏感信息；其余路径一律需要共享 token。
        if parsed.path == "/health":
            try:
                voices = _list_voices_cached()
                self._send(200, json.dumps({"ok": True, "voices": len(voices)}).encode(), "application/json")
            except Exception as exc:  # noqa: BLE001
                self._send(500, _json_err(500, f"edge-tts unavailable: {exc}"), "application/json")
            return
        if not self._authorized():
            self._send(401, _json_err(401, "unauthorized"), "application/json")
            return
        if parsed.path == "/v1/models":
            try:
                voices = _list_voices_cached()
                data = [{"id": v["ShortName"], "object": "model", "owned_by": "edge-tts"} for v in voices]
                self._send(200, json.dumps({"object": "list", "data": data}).encode(), "application/json")
            except Exception as exc:  # noqa: BLE001
                self._send(500, _json_err(500, f"list voices failed: {exc}"), "application/json")
            return
        self._send(404, _json_err(404, "not found"), "application/json")

    def do_POST(self):
        if not self._authorized():
            self._send(401, _json_err(401, "unauthorized"), "application/json")
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/v1/audio/speech":
            self._send(404, _json_err(404, "not found"), "application/json")
            return
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > 64 * 1024:
            self._send(400, _json_err(400, "body too large or empty"), "application/json")
            return
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            self._send(400, _json_err(400, "invalid JSON"), "application/json")
            return
        text = req.get("input")
        voice = req.get("voice") or DEFAULT_VOICE
        rate = req.get("rate")
        if not isinstance(text, str):
            self._send(400, _json_err(400, "missing 'input'"), "application/json")
            return
        try:
            audio = _pool.submit(_synthesize, text, str(voice), str(rate) if rate else None).result(timeout=30)
        except ValueError as exc:
            self._send(400, _json_err(400, str(exc)), "application/json")
            return
        except Exception as exc:  # noqa: BLE001
            self._send(502, _json_err(502, f"synthesis failed: {exc}", "upstream_error"), "application/json")
            return
        self._send(200, audio, "audio/mpeg")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    server.serve_forever()
