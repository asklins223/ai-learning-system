# SenseVoice 真实性能基准状态（P6 §13）

## 已就绪（可执行单元）
- 模型：`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09`（~158MB 压缩，int8）已下载解压于 `/tmp/sherpa-models/`（model.int8.onnx + tokens.txt + test_wavs/zh.wav 中文测试音频）
- 依赖：`sherpa-onnx@1.13.4`（npm，macos-arm64 加载验证 OK）
- 集成层：`companion-sherpa-sensevoice.ts`（SenseVoiceLocalRecognizer）+ `companion-asr-probe-runner.ts`（runSenseVoiceProbe）——8/8 单测
- 基准脚本：`apps/web/scripts/sensevoice-bench.mjs`（RTF×3 / 冷启动 / 峰值内存增量 + 合同 Gate 自动判定）

## 宿主环境执行结果（2026-08-11，修复后复测）
| 路径 | 结果 | 原因 |
| --- | --- | --- |
| Node 22.16 wasm-nodejs | ✅ | `coldStartMs=1594`、`warmRtfMax=0.18`、`peakMemoryDeltaMB=396`，Gate 全通过 |
| Node 20.19 wasm-nodejs | ✅ | `coldStartMs=2053`、`warmRtfMax=0.18`、`peakMemoryDeltaMB=454`，Gate 全通过 |
| Python pip sherpa-onnx | ❌ | 无 macos-arm64 wheel（python 3.9） |
| Docker | ❌ | buildx 权限（宿主 known-issue） |
| Electron 浏览器 wasm | ⏸ | 不再是本基准的必要路径；Node wasm-nodejs 已可执行 |

## 执行路径（Electron 真机 / CI）
```
# 模型放好（Electron userData 缓存目录或本地模型目录）
node apps/web/scripts/sensevoice-bench.mjs <model-dir> [test.wav]
```
基准输出 JSON（audioSeconds/coldStartMs/peakMemoryDeltaMB/rtf/warmRtfMax/text/gate）→ 供 ASR 路由决策（companion-asr-router）。`gate.pass=true` 表示冷启动 ≤3s、RTF ≤0.5、内存 ≤700MB 全部满足。

## 修复内容与结论
- `tokens.txt` 已移到 sherpa-onnx 要求的 `modelConfig.tokens`；`senseVoice` 子配置只保留模型、语言和 ITN 参数。
- 对齐 `sherpa-onnx@1.13.4` 的同步 `createOfflineRecognizer` 和 `acceptWaveform(sampleRate, samples)` API。
- 基准脚本现在采集真实峰值 RSS、显式输出 `gate.pass`（Gate 失败时退出码为 3），并释放每个 offline stream 与 recognizer 的 native 资源。
- 原阻塞是集成层配置/API 形状错误，不是 Node 的 pthread 环境限制；Node 20/22 均已完成真实模型执行，ASR 路由闭环可在当前路径完成。
