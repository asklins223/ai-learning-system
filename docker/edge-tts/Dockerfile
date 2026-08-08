# edge-tts 容器（TTS 服务）
#
# 在 Docker 环境内运行微软 Edge TTS，暴露 OpenAI 协议端点：
#   POST /v1/audio/speech  { model, input, voice } → audio/mpeg
#   GET  /v1/models        → 可用 voice 列表
#
# 该容器不依赖宿主 CLI；API 容器经 http://edge-tts:8080 访问。
FROM python:3.12-slim

# edge-tts 需要 ca-certificates（HTTPS 到微软端点）
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 锁定 edge-tts 版本（兼容 rany2/edge-tts）
RUN pip install --no-cache-dir "edge-tts>=6.1.0,<8"

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8080
USER nobody

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)"]

CMD ["python", "/app/server.py"]
