"use client";

import "@/app/styles/settings.css";
import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";
import { api, type SearchDriftResult } from "@/lib/api";
import { PageHeader } from "@/components/layout/PageHeader";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/icons";
import {
  MarkdownFilePicker,
  useMarkdownFileSelection,
} from "@/components/MarkdownFilePicker";
import { AIModelSettings } from "@/components/settings/AIModelSettings";

type SettingsSectionId = "account" | "model" | "export" | "import" | "search";
type SettingsIcon = ComponentType<SVGProps<SVGSVGElement>>;
type ReindexResult = {
  deleted: number;
  indexed: { note: number; source: number; card: number; evidence: number };
  errors: number;
};

const SETTINGS_SECTIONS: Array<{
  id: SettingsSectionId;
  label: string;
  caption: string;
  icon: SettingsIcon;
}> = [
  { id: "account", label: "个人账户", caption: "身份与工作区", icon: Icon.User },
  { id: "model", label: "模型与 API", caption: "个人 BYOK 配置", icon: Icon.Sparkle },
  { id: "export", label: "数据导出", caption: "保存完整副本", icon: Icon.Download },
  { id: "import", label: "内容导入", caption: "迁移 Markdown", icon: Icon.Inbox },
  { id: "search", label: "搜索维护", caption: "检测与重建索引", icon: Icon.Search },
];

function roleLabel(role: string) {
  switch (role.toLowerCase()) {
    case "owner":
      return "所有者";
    case "admin":
      return "管理员";
    case "member":
      return "成员";
    default:
      return role;
  }
}

function createImportId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `markdown-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function SettingsPanelHeading({
  eyebrow,
  title,
  description,
  icon: PanelIcon,
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon: SettingsIcon;
}) {
  return (
    <header className="settings-panel-heading">
      <span className="settings-panel-icon" aria-hidden="true">
        <PanelIcon />
      </span>
      <div>
        <span className="settings-panel-eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </header>
  );
}

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("account");
  const navRef = useRef<HTMLElement>(null);

  const [accountLoading, setAccountLoading] = useState(true);
  const [accountData, setAccountData] = useState<{
    email: string;
    role: string;
    workspaceName: string;
  } | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);

  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);

  const importFiles = useMarkdownFileSelection();
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importPartial, setImportPartial] = useState(false);
  const [importId, setImportId] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  const [driftResult, setDriftResult] = useState<SearchDriftResult | null>(null);
  const [driftLoading, setDriftLoading] = useState(false);
  const [driftError, setDriftError] = useState<string | null>(null);

  const [reindexLoading, setReindexLoading] = useState(false);
  const [reindexResult, setReindexResult] = useState<ReindexResult | null>(null);
  const [reindexTone, setReindexTone] = useState<"success" | "warning">("success");
  const [reindexError, setReindexError] = useState<string | null>(null);
  const [showReindexConfirm, setShowReindexConfirm] = useState(false);

  const loadAccount = useCallback(async () => {
    setAccountLoading(true);
    setAccountError(null);
    try {
      setAccountData(await api.getMe());
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "账户信息暂时无法读取");
    } finally {
      setAccountLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  useEffect(() => {
    const elements = SETTINGS_SECTIONS.map((item) => document.getElementById(item.id)).filter(
      (element): element is HTMLElement => Boolean(element),
    );
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
        const next = visible[0]?.target.id;
        if (next && SETTINGS_SECTIONS.some((item) => item.id === next)) {
          setActiveSection(next as SettingsSectionId);
        }
      },
      { rootMargin: "-18% 0px -68% 0px", threshold: [0, 0.08, 0.25] },
    );

    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const activeItem = nav.querySelector<HTMLElement>(`[href="#${activeSection}"]`);
    if (!activeItem) return;

    const navRect = nav.getBoundingClientRect();
    const itemRect = activeItem.getBoundingClientRect();
    const safeEdge = 12;
    const isOutside = itemRect.left < navRect.left + safeEdge || itemRect.right > navRect.right - safeEdge;
    if (!isOutside) return;

    let nextLeft = nav.scrollLeft;
    if (itemRect.left < navRect.left + safeEdge) {
      nextLeft -= navRect.left + safeEdge - itemRect.left;
    } else if (itemRect.right > navRect.right - safeEdge) {
      nextLeft += itemRect.right - (navRect.right - safeEdge);
    }

    nav.scrollTo({
      left: nextLeft,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [activeSection]);

  const importLimitMessage = importFiles.validationError;

  async function handleExportWorkspace() {
    setExportLoading(true);
    setExportError(null);
    setExportSuccess(null);
    try {
      const blob = await api.exportWorkspace();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `workspace-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Safari may not have consumed the object URL when the click handler returns.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setExportSuccess("工作区副本已开始下载");
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "工作区导出失败");
    } finally {
      setExportLoading(false);
    }
  }

  async function handleImport() {
    if (importFiles.items.length === 0 || importLimitMessage || importFiles.reading) return;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    setImportPartial(false);
    try {
      const requestId = importId || createImportId();
      if (!importId) setImportId(requestId);
      const result = await api.importMarkdown(importFiles.items, requestId);
      const failed = result.errors?.length ?? 0;
      if (failed > 0) {
        const failedKeys = result.errors!
          .map((item) => importFiles.validFiles[item.index]?.key)
          .filter((key): key is string => Boolean(key));
        // 后端若返回了无法映射的异常索引，保留当前选择，避免把待重试文件误清空。
        if (failedKeys.length > 0) importFiles.retainFiles(failedKeys);
        setImportPartial(true);
        setImportResult(`导入完成：成功 ${result.imported} 篇，失败 ${failed} 篇`);
        setImportError(
          result.errors!
            .map((item) => {
              const filename = importFiles.validFiles[item.index]?.name;
              return `${filename || item.title || `第 ${item.index + 1} 个文件`}：${item.error}`;
            })
            .join("\n"),
        );
      } else {
        setImportResult(
          result.idempotent
            ? `批次导入完成，共 ${result.imported} 篇；已自动跳过此前成功的内容`
            : `已成功导入 ${result.imported} 篇笔记`,
        );
        importFiles.clearFiles();
        setImportId(createImportId());
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Markdown 导入失败");
    } finally {
      setImporting(false);
    }
  }

  const checkDrift = useCallback(async () => {
    setDriftLoading(true);
    setDriftError(null);
    setReindexResult(null);
    try {
      setDriftResult(await api.detectSearchDrift());
    } catch (error) {
      setDriftError(error instanceof Error ? error.message : "索引检测失败");
      setDriftResult(null);
    } finally {
      setDriftLoading(false);
    }
  }, []);

  const handleReindex = useCallback(async () => {
    setShowReindexConfirm(false);
    setReindexLoading(true);
    setReindexError(null);
    setReindexResult(null);
    try {
      const result = await api.reindexSearch();
      setReindexResult(result);
      setReindexTone(result.errors > 0 ? "warning" : "success");
      setDriftResult(null);
    } catch (error) {
      setReindexError(error instanceof Error ? error.message : "索引重建失败");
    } finally {
      setReindexLoading(false);
    }
  }, []);

  const isOwner = accountData?.role.toLowerCase() === "owner";
  const isKnownNonOwner = Boolean(accountData && !isOwner);
  const ownerActionDisabled = accountLoading || !isOwner;

  return (
    <div className="settings-page">
      <PageHeader
        className="workspace-page-header"
        title="个人设置"
        kicker="PERSONAL DESK · 账户与数据"
        subtitle="管理当前身份、工作区数据与搜索维护工具；每项操作都保留清晰边界。"
        actions={<ThemeToggle className="settings-theme-toggle" />}
      />

      <div className="settings-content">
        <div className="settings-layout">
          <aside className="settings-rail" aria-label="设置目录">
            <div className="settings-rail-title">
              <span>SETTINGS INDEX</span>
              <strong>设置目录</strong>
            </div>
            <nav ref={navRef} className="settings-nav">
              {SETTINGS_SECTIONS.map((item, index) => {
                const NavIcon = item.icon;
                return (
                  <a
                    key={item.id}
                    href={`#${item.id}`}
                    className={`settings-nav-item${activeSection === item.id ? " is-active" : ""}`}
                    aria-current={activeSection === item.id ? "location" : undefined}
                    onClick={() => setActiveSection(item.id)}
                  >
                    <span className="settings-nav-index">0{index + 1}</span>
                    <span className="settings-nav-icon" aria-hidden="true"><NavIcon /></span>
                    <span className="settings-nav-copy">
                      <strong>{item.label}</strong>
                      <small>{item.caption}</small>
                    </span>
                    <Icon.Chevron aria-hidden="true" />
                  </a>
                );
              })}
            </nav>
            <div className="settings-rail-note">
              <Icon.Lock aria-hidden="true" />
              <p><strong>数据归你所有</strong><span>导出与索引维护不会修改笔记正文。</span></p>
            </div>
          </aside>

          <div className="settings-panels">
            <section id="account" className="settings-panel">
              <SettingsPanelHeading
                eyebrow="IDENTITY"
                title="当前账户"
                description="确认正在操作的身份与工作区，避免在错误空间中维护数据。"
                icon={Icon.User}
              />

              <div className="settings-profile-card">
                <div className="settings-profile-main">
                  <span className="settings-avatar-wrap">
                    {accountData && isOwner ? (
                      <Image
                        src="/images/avatar-owner-custom.jpg"
                        alt="当前账户头像"
                        width={80}
                        height={80}
                        priority
                      />
                    ) : (
                      <span className="settings-avatar-fallback" aria-label="账户头像">
                        {accountData?.email?.trim().charAt(0).toUpperCase() || "?"}
                      </span>
                    )}
                    {accountData && !accountError && <i aria-hidden="true" />}
                  </span>
                  <div className="settings-profile-copy">
                    <span className="settings-profile-label">SIGNED IN AS</span>
                    {accountLoading ? (
                      <span className="settings-account-skeleton" aria-label="正在读取账户信息" />
                    ) : (
                      <h3>{accountData?.email || "账户信息未加载"}</h3>
                    )}
                    <p>{accountData ? "当前登录账户" : "正在确认当前账户"}</p>
                  </div>
                  <button
                    type="button"
                    className="settings-icon-button"
                    onClick={() => void loadAccount()}
                    disabled={accountLoading}
                    aria-label="刷新账户信息"
                    title="刷新账户信息"
                  >
                    <Icon.Refresh className={accountLoading ? "settings-spin" : undefined} />
                  </button>
                </div>

                {accountError && (
                  <div className="settings-notice is-danger" role="alert">
                    <Icon.Warn aria-hidden="true" />
                    <span>{accountError}</span>
                    <button type="button" onClick={() => void loadAccount()}>重试</button>
                  </div>
                )}

                <dl className="settings-account-facts">
                  <div>
                    <dt>账户角色</dt>
                    <dd>{accountLoading ? "—" : accountData ? roleLabel(accountData.role) : "未知"}</dd>
                    <small>决定当前工作区权限</small>
                  </div>
                  <div>
                    <dt>当前工作区</dt>
                    <dd>{accountLoading ? "—" : accountData?.workspaceName || "未知"}</dd>
                    <small>本页操作仅作用于此空间</small>
                  </div>
                  <div>
                    <dt>会话状态</dt>
                    <dd className={accountData ? "is-success" : undefined}>
                      {accountLoading ? "确认中" : accountData ? "已连接" : "待重试"}
                    </dd>
                    <small>身份凭据由当前设备保存</small>
                  </div>
                </dl>
              </div>
            </section>

            <section id="model" className="settings-panel">
              <SettingsPanelHeading
                eyebrow="PERSONAL AI · BYOK"
                title="模型与 API 配置"
                description="为当前账户选择模型服务并安全保存自己的 API Key；完整密钥不会回显给浏览器。"
                icon={Icon.Sparkle}
              />
              <AIModelSettings isOwner={isOwner} accountLoading={accountLoading} />
            </section>

            <section id="export" className="settings-panel">
              <SettingsPanelHeading
                eyebrow="PORTABILITY"
                title="导出工作区副本"
                description="把主要学习对象整理为 JSON 文件，便于备份、迁移或自行分析。"
                icon={Icon.Download}
              />
              <div className="settings-operation-card">
                <div className="settings-operation-mark is-export" aria-hidden="true"><Icon.Archive /></div>
                <div className="settings-operation-copy">
                  <h3>完整数据快照</h3>
                  <p>包含笔记、学习卡、证据、验证与理解状态；导出过程不会修改线上数据。</p>
                  <div className="settings-operation-tags" aria-label="导出内容">
                    <span>JSON 格式</span><span>只读副本</span><span>当前工作区</span>
                  </div>
                </div>
                <button
                  className="settings-primary-button"
                  onClick={() => void handleExportWorkspace()}
                  disabled={exportLoading || ownerActionDisabled}
                  title={isKnownNonOwner ? "仅工作区所有者可导出完整副本" : undefined}
                  type="button"
                >
                  {exportLoading ? <Icon.Refresh className="settings-spin" /> : <Icon.Download />}
                  {exportLoading ? "正在整理" : "下载工作区副本"}
                </button>
              </div>
              {isKnownNonOwner && (
                <div className="settings-permission-note"><Icon.Lock />完整工作区导出仅对所有者开放。</div>
              )}
              {exportSuccess && (
                <div className="settings-notice is-success" role="status">
                  <Icon.Check aria-hidden="true" /><span>{exportSuccess}</span>
                </div>
              )}
              {exportError && (
                <div className="settings-notice is-danger" role="alert">
                  <Icon.Warn aria-hidden="true" /><span>{exportError}</span>
                </div>
              )}
            </section>

            <section id="import" className="settings-panel">
              <SettingsPanelHeading
                eyebrow="MIGRATION"
                title="导入 Markdown 文件"
                description="选择或拖入 .md / .markdown 文件；每个文件创建一篇笔记，不再需要粘贴文本。"
                icon={Icon.Inbox}
              />

              <div className="settings-import-desk">
                <div className="settings-import-toolbar">
                  <div>
                    <span>FILE IMPORT DESK</span>
                    <strong>Markdown 文件导入台</strong>
                  </div>
                  <div className="settings-import-stats" aria-live="polite">
                    <span><strong>{importFiles.summary.files}</strong> 个文件</span>
                    <span><strong>{importFiles.summary.characters.toLocaleString("zh-CN")}</strong> 字符</span>
                    {importFiles.summary.errors > 0 && <span className="is-danger"><strong>{importFiles.summary.errors}</strong> 个异常</span>}
                  </div>
                </div>
                <MarkdownFilePicker
                  id="settings-import-files"
                  selection={importFiles}
                  disabled={importing}
                  className="settings-markdown-file-picker"
                  onSelectionChange={() => {
                    setImportId("");
                    setImportResult(null);
                    setImportError(null);
                    setImportPartial(false);
                  }}
                />
                <div className="settings-import-foot">
                  <p
                    className={importLimitMessage ? "is-invalid" : undefined}
                    role={importLimitMessage ? "alert" : undefined}
                  >
                    <Icon.Warn aria-hidden="true" />
                    {importLimitMessage ?? "单次最多 100 个文件、每个文件最多 500,000 字符；仅支持 UTF-8 Markdown。"}
                  </p>
                  <div>
                    <button
                      className="settings-secondary-button"
                      onClick={() => {
                        importFiles.clearFiles();
                        setImportId(createImportId());
                        setImportResult(null);
                        setImportError(null);
                        setImportPartial(false);
                      }}
                      disabled={importing || importFiles.reading || importFiles.files.length === 0}
                      type="button"
                    >
                      清空文件
                    </button>
                    <button
                      className="settings-primary-button"
                      onClick={() => void handleImport()}
                      disabled={importing || importFiles.reading || importFiles.items.length === 0 || Boolean(importLimitMessage)}
                      aria-busy={importing}
                      type="button"
                    >
                      {importing ? <Icon.Refresh className="settings-spin" /> : <Icon.Inbox />}
                      {importing ? "正在导入" : `确认导入${importFiles.summary.ready > 0 ? ` ${importFiles.summary.ready} 篇` : ""}`}
                    </button>
                  </div>
                </div>
                {importResult && (
                  <div className={`settings-notice ${importPartial ? "is-warning" : "is-success"}`} role="status">
                    {importPartial ? <Icon.Warn aria-hidden="true" /> : <Icon.Check aria-hidden="true" />}<span>{importResult}</span>
                  </div>
                )}
                {importError && (
                  <div className={`settings-notice ${importPartial ? "is-warning" : "is-danger"}`} role="alert">
                    <Icon.Warn aria-hidden="true" />
                    <pre>{importError}</pre>
                  </div>
                )}
              </div>
            </section>

            <section id="search" className="settings-panel">
              <SettingsPanelHeading
                eyebrow="MAINTENANCE"
                title="搜索索引维护"
                description="检查搜索结果是否与真实学习对象一致，仅在出现缺失或旧内容时重建。"
                icon={Icon.Search}
              />

              <div className="settings-maintenance-grid">
                <article className="settings-maintenance-card">
                  <span className="settings-maintenance-number">01</span>
                  <span className="settings-maintenance-icon" aria-hidden="true"><Icon.Search /></span>
                  <h3>检测索引漂移</h3>
                  <p>对比搜索索引和业务数据，识别幽灵文档、缺失对象及过期内容。</p>
                  <button
                    className="settings-secondary-button"
                    onClick={() => void checkDrift()}
                    disabled={driftLoading || reindexLoading || ownerActionDisabled}
                    title={isKnownNonOwner ? "仅工作区所有者可运行索引检测" : undefined}
                    type="button"
                  >
                    {driftLoading ? <Icon.Refresh className="settings-spin" /> : <Icon.Search />}
                    {driftLoading ? "正在检测" : "运行一致性检测"}
                  </button>
                </article>

                <article className="settings-maintenance-card is-caution">
                  <span className="settings-maintenance-number">02</span>
                  <span className="settings-maintenance-icon" aria-hidden="true"><Icon.Refresh /></span>
                  <h3>重建搜索索引</h3>
                  <p>清理派生索引并从真实学习数据重新生成；不会删除笔记或学习卡。</p>
                  <button
                    className="settings-primary-button"
                    onClick={() => setShowReindexConfirm(true)}
                    disabled={reindexLoading || driftLoading || ownerActionDisabled}
                    title={isKnownNonOwner ? "仅工作区所有者可重建索引" : undefined}
                    type="button"
                  >
                    {reindexLoading ? <Icon.Refresh className="settings-spin" /> : <Icon.Refresh />}
                    {reindexLoading ? "正在重建" : "重建索引"}
                  </button>
                </article>
              </div>

              {isKnownNonOwner && (
                <div className="settings-permission-note"><Icon.Lock />搜索维护工具仅对所有者开放。</div>
              )}

              {driftError && (
                <div className="settings-notice is-danger" role="alert">
                  <Icon.Warn aria-hidden="true" /><span>{driftError}</span>
                </div>
              )}
              {reindexError && (
                <div className="settings-notice is-danger" role="alert">
                  <Icon.Warn aria-hidden="true" /><span>{reindexError}</span>
                </div>
              )}
              {reindexResult && (
                <div className={`settings-notice is-${reindexTone}`} role="status">
                  {reindexTone === "warning" ? <Icon.Warn aria-hidden="true" /> : <Icon.Check aria-hidden="true" />}
                  <div className="settings-reindex-result">
                    <strong>
                      {reindexResult.errors > 0
                        ? `重建完成，但有 ${reindexResult.errors} 条对象未能写入`
                        : `索引已重建，并清理 ${reindexResult.deleted} 条旧索引`}
                    </strong>
                    <dl>
                      <div><dt>笔记</dt><dd>{reindexResult.indexed.note}</dd></div>
                      <div><dt>来源</dt><dd>{reindexResult.indexed.source}</dd></div>
                      <div><dt>学习卡</dt><dd>{reindexResult.indexed.card}</dd></div>
                      <div><dt>证据</dt><dd>{reindexResult.indexed.evidence}</dd></div>
                    </dl>
                  </div>
                </div>
              )}

              {driftResult && (
                <div className={`settings-drift-card ${driftResult.hasDrift ? "has-drift" : "is-clean"}`}>
                  <div className="settings-drift-heading">
                    <span aria-hidden="true">{driftResult.hasDrift ? <Icon.Warn /> : <Icon.Check />}</span>
                    <div>
                      <h3>{driftResult.hasDrift ? "检测到索引差异" : "搜索索引与学习数据一致"}</h3>
                      <p>{driftResult.hasDrift ? "可核对下方差异后再决定是否重建。" : "当前无需执行重建操作。"}</p>
                    </div>
                  </div>
                  <div className="settings-drift-stats">
                    {(["note", "source", "card", "evidence"] as const).map((type) => {
                      const labels = { note: "笔记", source: "来源", card: "学习卡", evidence: "证据" };
                      return (
                        <div key={type}>
                          <span>{labels[type]}</span>
                          <strong>{driftResult.actual[type]} <i>/ {driftResult.expected[type]}</i></strong>
                        </div>
                      );
                    })}
                  </div>
                  {driftResult.hasDrift && (
                    <ul className="settings-drift-details">
                      <li><span>幽灵文档</span><strong>{driftResult.ghosts.length}</strong></li>
                      <li><span>缺失文档</span><strong>{driftResult.missing.length}</strong></li>
                      <li><span>过期标题</span><strong>{driftResult.staleTitles.length}</strong></li>
                      <li><span>过期正文</span><strong>{driftResult.staleBodies.length}</strong></li>
                    </ul>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={showReindexConfirm}
        title="确认重建搜索索引？"
        message="系统会删除派生索引并从当前工作区重新生成。学习数据不会被删除，但搜索可能在短时间内不可用。"
        confirmLabel="确认重建"
        cancelLabel="暂不重建"
        loading={reindexLoading}
        onCancel={() => setShowReindexConfirm(false)}
        onConfirm={() => void handleReindex()}
      />
    </div>
  );
}
