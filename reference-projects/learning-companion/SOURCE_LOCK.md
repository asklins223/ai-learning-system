# 外部参考源码锁定清单

生成日期：2026-08-09

以下仓库均以 `git clone --depth 1 --single-branch` 拉取。该清单用于复现本轮研究上下文，不表示依赖采用决定，也不自动授权复制任何上游代码或资产。

| 项目 | 分支 | 锁定 commit | origin | 许可证文件 |
| --- | --- | --- | --- | --- |
| EchoBot | `main` | `08e97a4a33b2ab611d24dd997038c1ec95ac6926` | <https://github.com/KdaiP/EchoBot.git> | MIT (`LICENSE`) |
| AIRI | `main` | `98fa1f0855bd18f1af67cb773d7b05b01e0b3790` | <https://github.com/moeru-ai/airi.git> | MIT (`LICENSE`) |
| Soullink Emotion SDK | `main` | `06aec408beb4aa2f45971124d57c95bd1373a3a6` | <https://github.com/nanlingyin/soullink-emotion-sdk.git> | MIT (`LICENSE`) |
| Meochat-APP | `improved-version` | `c2e0f59a392dda1440d6da758360afe1f39f921c` | <https://github.com/Mios-dream/Meochat-APP.git> | GPL-3.0 (`LICENSE`) |
| MoeChat | `main` | `f3707e9bae73196dda41820abe0a53c6021269c9` | <https://github.com/AlfreScarlet/MoeChat.git> | GPL-3.0 (`LICENSE`) |
| see-through | `main` | `7f139bb25c46a0c8ac720d95ddab185fcda5451c` | <https://github.com/shitagaki-lab/see-through.git> | Apache-2.0 (`LICENSE`) |

## 校验约定

研究或实施前，可在项目根目录运行：

```bash
for repo in reference-projects/learning-companion/repos/*; do
  git -C "$repo" status --short
  git -C "$repo" rev-parse HEAD
  git -C "$repo" remote get-url origin
done
```

预期每个 `status --short` 均为空，HEAD 与上表一致。若主动更新任何仓库，必须重新检查许可证、上游变更和供应链风险，然后同步更新本文件及桌宠重构方案；禁止无记录地执行批量 `git pull`。
