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
import queue as _queue
import threading
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


def _validate_input(input_text: str, voice: str, rate: str):
    """公共输入校验：返回 (text, voice, rate)；非法抛 ValueError。"""
    text = input_text.strip()
    if not text:
        raise ValueError("empty input")
    if len(text) > MAX_INPUT_LEN:
        raise ValueError(f"input too long (>{MAX_INPUT_LEN})")
    if SSML_RE.search(text) or URL_RE.search(text) or SCRIPT_RE.search(text):
        raise ValueError("unsafe input (SSML/URL/script markers not allowed)")
    return text, voice, rate or "+0%"


def _synthesize(input_text: str, voice: str, rate: str) -> bytes:
    """同步合成（在 executor 中运行；edge-tts 6.x 为同步 API）。"""
    text, voice, rate = _validate_input(input_text, voice, rate)

    communicate = edge_tts.Communicate(text, voice=voice, rate=rate)

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

    def handle(self):
        """客户端中途断开不是服务端故障。

        调用方（worker）对每段音频都有截止，超时就会放弃连接；此时 `self.wfile.write`
        抛 BrokenPipeError / ConnectionResetError，`socketserver` 默认把它打成
        traceback 并关掉连接——实测容器日志里 15 次 "edge-tts unavailable" 500 之外
        还有一批从 do_GET 冒出来的 BrokenPipeError，把真正的故障淹了。
        请求已经无法送达，安静收场即可。
        """
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # 头已经发不出去，同上：客户端不在了。
            self.close_connection = True

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
        if parsed.path not in ("/v1/audio/speech", "/v1/audio/speech/stream"):
            self._send(404, _json_err(404, "not found"), "application/json")
            return
        is_stream = parsed.path.endswith("/stream")
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

        if is_stream:
            try:
                _validate_input(text, str(voice), str(rate) if rate else None)
            except ValueError as exc:
                self._send(400, _json_err(400, str(exc)), "application/json")
                return
            self._send_stream(text, str(voice), str(rate) if rate else None)
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

    def _send_stream(self, text: str, voice: str, rate):
        """chunked 流式响应：audio chunk 边产边写；流中异常 → 终止 chunk（客户端 fail closed）。"""
        # Bound the hand-off queue and signal the producer when the client
        # disconnects. Without both, a barge-in/slow client leaves edge-tts
        # producing into an unbounded queue until the synthesis completes.
        audio_queue = _queue.Queue(maxsize=8)
        cancel_event = threading.Event()
        _pool.submit(_synthesize_stream, text, voice, rate, audio_queue, cancel_event)
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            while True:
                try:
                    item = audio_queue.get(timeout=0.5)
                except _queue.Empty:
                    if cancel_event.is_set():
                        break
                    continue
                if item is None:
                    break
                if isinstance(item, Exception):
                    break
                frame = f"{len(item):x}\r\n".encode("ascii") + item + b"\r\n"
                self.wfile.write(frame)
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            cancel_event.set()  # 客户端 abort（打断）——停止生产者背压等待
        finally:
            cancel_event.set()


def _synthesize_stream(input_text: str, voice: str, rate: str, audio_queue, cancel_event: threading.Event):
    """流式合成：audio chunk 逐个放入 queue；正常结束放 None；异常放 Exception。"""
    def put(item) -> bool:
        while not cancel_event.is_set():
            try:
                audio_queue.put(item, timeout=0.25)
                return True
            except _queue.Full:
                continue
        return False

    try:
        text, voice, rate = _validate_input(input_text, voice, rate)
        communicate = edge_tts.Communicate(text, voice=voice, rate=rate)

        async def _run():
            async for chunk in communicate.stream():
                if cancel_event.is_set():
                    break
                if chunk.get("type") == "audio":
                    if not put(chunk["data"]):
                        break

        asyncio.run(_run())
        put(None)
    except Exception as exc:  # noqa: BLE001
        put(exc)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    server.serve_forever()
