# DS鲸鱼娘（DS鼠控版）

- 来源：用户（Owner）2026-09-20 提供，`DS鲸鱼娘.zip`（DS鼠控版）。
- 模型作者：B站 @氵六青（11272072），无偿分享模型。
- 作者许可（《使用须知.txt》）：商用直播 √、自印物料 √；禁止任何形式的盗用以及出售。
- 集成时的整理（2026-09-20）：
  - 只保留运行时需要的文件：`c_0120.moc3`、双 2048 纹理、物理、cdi3 与 `motions/`、`expressions/`，
    并剔除 `.zip`、`.DS_Store`、`items_pinned_to_model.json` 和 `c_0120.vtube.json`（VTube Studio 配置）。
  - 原始 `c_0120.model3.json` 未声明任何 Motions/Expressions 组，且 LipSync 组为空；
    运行时副本补上动作组、ASCII 别名表情与 `ParamMouthOpenY` 口型组。
    口型参数：该模型没有 `ParamA`，口型写 `ParamMouthOpenY`（见 `window-live2d-contract.ts` 注册表）。
  - 表情文件名保留中文原名，`model3.json` 里的 `Name` 用 ASCII 别名，避免 URL/转义问题。
- 接入范围（作者原包 7 条动作 / 44 个表情，本目录 5 条动作 / 30 个表情）：
  - 动作：`Idle`、`Bubble`（吹泡泡糖）、`Spray`（鲸鱼喷水）、`Selfie`（举手机自拍）、
    `SelfieQuick`（快速自拍）。未接的 `开盖.motion3.json` 与 `番茄酱.motion3.json` 驱动的是
    `keyboard/xbox/danbaofan/ji` 这套「蛋包饭点餐」桌面玩法的参数，伴星没有这张桌子，
    接进来只会看到她对着空气挤番茄酱。
  - 表情：12 个情绪脸 + 4 个额外脸部（呆呆眼/闭眼口水/阴暗/吐舌）+ 4 副眼镜（圆/方/椭圆/墨镜）
    + 10 个贴纸与小道具（猫猫/兔兔/蝴蝶结贴纸、情绪花花、心跳、吐魂、爱心、喵喵手、双手比耶、头顶鲸）。
  - 未接的表情按原作者的语义分两类：发型与身份类（头箍=摘掉发箍、单边马尾）会永久改形象，
    不适合由回复内容触发；桌面道具类（蛋包饭、番茄酱、魔爪、巴菲、深色桌布、点菜、橡皮、画笔、
    撤回、手机换色、鲸鱼放桌上）同样需要那张不存在的桌子。
- 完整 SHA-256 清单见同目录 `manifest.json`。原作者的《使用须知.txt》《按键表.txt》
  保存在用户提供的原目录（`~/Downloads/DS鲸鱼娘/`），本目录以 `manifest.json` 记录许可要点。
