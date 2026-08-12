# P3 测试汇总（自动验证）

| 套件 | 命令 | 结果 |
|---|---|---|
| api 全量 | `npm test`（apps/api） | 3010 tests / 3006 pass / **0 fail** |
| shared | `npm test`（packages/shared） | 397 / 397 / 0 |
| web companion-pet | node --import tsx --test（pet-reducer 24 + chat 8 + bubble-model + playback 8） | 47 / 47 / 0 |
| 集成（conversation-postgres） | `node --import tsx --test --test-concurrency=1 --test-timeout=30000 src/integration-tests/companion-conversation-postgres.integration.ts` | **23 / 23**，cancelled 0，无残留 |
| ffprobe 单测 | ffprobe.test.ts | 4 / 4 |
| worker tsc | `npx tsc --noEmit`（ai-worker） | 0 error |
| api tsc | `npx tsc --noEmit`（apps/api） | 0 error |
| web tsc | `npx tsc --noEmit`（apps/web） | 0 error |
| migration 集成 | companion-migration-postgres.integration.ts | 3 / 3（P2-2/5 验证） |
| desktop 打包 smoke | `npm run dist:arm64`（apps/desktop） | .app 生成成功；dmg 因宿主 hdiutil 失败（见 known-issues） |
| web build | `npm run build`（apps/web） | 17/17 静态页成功 |

P3 覆盖的 runbook 7.3 自动测试项（§7.4 清单抽样）：
- permission denied / voiceOff（reducer 24/24，含 operationEpoch 迟到拒绝、barge-in）
- 0 字节/短音频/垃圾字节（ffprobe 3 场景 + 集成 415 零写入）
- duration 超限（200..60000ms 分类）
- ASR 失败 fail closed（transcribe 415）
- voiceArtifactId/hash/expiry 原子绑定 + 重复/过期 fail closed（集成 22-23）
- TTS strict ref：segmentId 不匹配 400、event 缺失 404、cancelled run 409（集成 23）
- 分句上限/乱序/旧 generation fence（playback 8/8 + worker 切句 6/6）
- Worker 单一切句所有权（切句仅在 worker；客户端只消费 voice.segment.ready）
- §11.6 临时音频 crash cleanup（ffprobe 4/4）
