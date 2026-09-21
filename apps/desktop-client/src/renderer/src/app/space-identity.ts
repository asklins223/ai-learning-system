import type { SpaceIdentity } from "./room-store";

/**
 * 空间身份的中文说法——顶栏胶囊和空间菜单的每一行都读这一个函数。
 *
 * 之前 `HudAccountMenu` 里自带一份 `roleLabel()`，它对个人空间**吞掉角色**、只说
 * "Personal"，于是「我在这个空间是什么身份」在界面上没有稳定答案；顶栏胶囊要的
 * 恰好是这句话，各写一份就会有两套真相。
 *
 * 只读态必须落成文字：`docs/plans/learning-companion/01-4-security-privacy-a11y.md`
 * 要求颜色不能是唯一载体，只把胶囊转成冷色等于没说。
 */
export function spaceRoleLabel(identity: Pick<SpaceIdentity, "role" | "isPersonal">): string {
  if (identity.role === "member") return "成员 · 只读";
  return identity.isPersonal ? "个人空间 · 所有者" : "协作空间 · 所有者";
}
