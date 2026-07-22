"use client";

import { useCallback, useEffect, useState } from "react";
import { api, IDENTITY_CHANGED_EVENT, type CurrentUser } from "@/lib/api";

/**
 * 当前账户与工作区上下文。
 *
 * AppShell 的桌面、平板与手机入口都需要展示同一份工作区信息。统一在
 * 这里订阅 identity change，避免各端自己维护一套易失步的加载逻辑。
 */
export function useCurrentUser(): {
  currentUser: CurrentUser | null;
  loading: boolean;
  error: boolean;
  reload: () => void;
} {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setError(false);
    void api.getMe()
      .then((user) => {
        setCurrentUser(user);
        setError(false);
      })
      .catch(() => {
        setCurrentUser(null);
        setError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
    window.addEventListener(IDENTITY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(IDENTITY_CHANGED_EVENT, reload);
  }, [reload]);

  return { currentUser, loading, error, reload };
}

/**
 * RBAC hook：判断当前用户在当前工作区是否为所有者。
 *
 * 所有者（owner）可以增删改工作区数据（笔记、来源、卡片等）；
 * 成员（member）只读工作区数据，但可以验证、复习、查看理解状态
 * 等用户私有操作。
 *
 * 判定逻辑复用后端 /auth/me 返回的 role 字段：
 * - role === "owner" → 协作工作区的所有者
 * - isPersonal === true → 个人工作区（创建者即所有者）
 *
 * 使用缓存的 api.getMe()，不产生额外网络请求。
 */
export function useIsOwner(): { isOwner: boolean; loading: boolean } {
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      api.getMe()
        .then((user: CurrentUser) => {
          if (cancelled) return;
          setIsOwner(user.role === "owner" || user.isPersonal);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          // 获取失败时默认为非 owner，避免误开放写权限
          setIsOwner(false);
          setLoading(false);
        });
    };

    check();

    const handleIdentityChange = () => {
      setLoading(true);
      check();
    };
    window.addEventListener(IDENTITY_CHANGED_EVENT, handleIdentityChange);

    return () => {
      cancelled = true;
      window.removeEventListener(IDENTITY_CHANGED_EVENT, handleIdentityChange);
    };
  }, []);

  return { isOwner, loading };
}
