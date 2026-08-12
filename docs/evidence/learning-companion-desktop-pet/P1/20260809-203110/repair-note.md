# Edge repair

根因：上一版在透明 RGB 仍含棋盘色时做 2× straight-alpha resize，棋盘 RGB 被插值到角色边缘。

本版：从冻结原图重新裁切，使用边界连通 checker removal；对与 checker 色接近且紧邻透明区的边界像素做受控去溢色；清空 hidden RGB；使用 premultiplied-alpha LANCZOS 只缩放一次；最后重新对齐脚底锚点并生成 hit-mask。

旧版已备份至 `/tmp/companion-sprite-v1-before-repair`。
