# P1 Level A draft asset pack

来源：`docs/image/learning-companion-character-action-reference.png`，SHA-256 固定为合同中的 `159f23153339db24815fcd9f8ed700907f55652ac15e859957c05e9b85dba2e5`。

已完成：

- 8 个语义姿态映射到 `idle`, `invite`, `navigate`, `analyze`, `listen`, `think`, `encourage`, `celebrate`；
- 统一为 `700×860` RGBA 画布和 `(350,824)` 脚底锚点；
- 每个姿态独立生成 `128×128`、2048 bytes、MSB-first hit-mask；
- 生成 manifest、文件 hash、opaque bounds 和四底色 QA contact sheet。

仍阻塞：

- `LICENSE.json` 尚未获得真实权属、权限、Owner 和批准时间，因此刻意保持 fail-closed；
- P0 Gate 尚未通过；
- P1 visual approval 尚未批准。

校验结果见 [`asset-validation.json`](./asset-validation.json)。
