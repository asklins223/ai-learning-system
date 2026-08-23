"use client";

import "@/app/styles/benchmark.css";
import Link from "next/link";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  type BenchmarkLabel,
  type BenchmarkReport,
} from "@/lib/api";
import { PageHeader } from "@/components/layout/PageHeader";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { BENCHMARK_QUALITY_THRESHOLDS } from "@ailearn/shared/constants";

type Phase =
  | "idle"
  | "running"
  | "reviewing"
  | "submittingLabels"
  | "labeled"
  | "failed";

interface LabelEntry {
  isCorrectlyAligned: boolean | null;
  expectedBlockOrdinal: number | null;
}

type LabelState = Record<string, Record<number, LabelEntry>>;

interface PendingReviewTarget {
  noteIndex: number;
  keyPointOrdinal: number;
}

function labelsFromReport(report: BenchmarkReport): LabelState {
  const next: LabelState = {};
  for (const note of report.results) {
    next[note.noteFile] = {};
    for (const keyPoint of note.keyPoints) {
      next[note.noteFile][keyPoint.ordinal] = {
        isCorrectlyAligned: null,
        expectedBlockOrdinal: null,
      };
    }
  }
  return next;
}

function labelsFromSaved(saved: BenchmarkLabel[]): LabelState {
  const next: LabelState = {};
  for (const note of saved) {
    next[note.noteFile] = {};
    for (const keyPoint of note.keyPoints) {
      next[note.noteFile][keyPoint.ordinal] = {
        isCorrectlyAligned: keyPoint.isCorrectlyAligned,
        expectedBlockOrdinal: keyPoint.expectedBlockOrdinal,
      };
    }
  }
  return next;
}

function formatMetric(value: number | null): string {
  if (value === null) return "—";
  return (value * 100).toFixed(1);
}

function phasePresentation(phase: Phase) {
  switch (phase) {
    case "running":
      return { label: "运行中", title: "正在生成本轮测评报告", description: "系统正依次创建样本、生成学习卡并完成证据对齐。" };
    case "reviewing":
      return { label: "待复核", title: "逐条确认 Claim 与 Quote", description: "指标尚未定稿；需要人工判断每条引用是否准确。" };
    case "submittingLabels":
      return { label: "提交中", title: "正在计算最终指标", description: "人工判断已锁定，系统正在写入标注并重新计算 Precision。" };
    case "labeled":
      return { label: "已完成", title: "本轮测评已经完成", description: "报告已包含人工复核结果，可查看最终判定或开始新一轮。" };
    case "failed":
      return { label: "运行失败", title: "本轮测评没有完成", description: "上一份报告仍被保留；检查服务后可重新运行。" };
    case "idle":
    default:
      return { label: "准备就绪", title: "运行一次完整证据对齐测评", description: "使用内置样本验证学习卡生成和原文引用链路。" };
  }
}

function AlignmentChip({ alignment }: { alignment: string }) {
  const presentation =
    alignment === "aligned"
      ? { tone: "success", label: "硬引用" }
      : alignment === "soft"
        ? { tone: "warning", label: "软引用" }
        : { tone: "danger", label: "未对齐" };

  return (
    <span className={`bench-align-chip is-${presentation.tone}`} title={alignment}>
      <i aria-hidden="true" />
      {presentation.label}
    </span>
  );
}

export default function BenchmarkPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sampleCount, setSampleCount] = useState<number | null>(null);
  const [labels, setLabels] = useState<LabelState>({});
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialLoadIncomplete, setInitialLoadIncomplete] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [expandedNotes, setExpandedNotes] = useState<Record<string, boolean>>({});
  // F12（round4）：稳定 onToggle——此前每渲染新建箭头闭包，配合 memo(NoteSection)
  // 会让 memo 因 props 引用变化每渲失效。这里用 ref 镜像 report，展开切换不需要
  // 重新渲染周期内的新闭包。
  const reportRef = useRef(report);
  // 第八轮 🟡B-3：镜像写入移入 useEffect（渲染期写 ref 是纯度过反模式）。
  useEffect(() => {
    reportRef.current = report;
  }, [report]);
  const toggleNote = useCallback((noteFile: string) => {
    setExpandedNotes((current) => {
      if (current[noteFile] != null) return { ...current, [noteFile]: !current[noteFile] };
      // 首次切换：取默认展开态（前两条或含 error 的笔记默认展开）取反。
      const results = reportRef.current?.results ?? [];
      const idx = results.findIndex((note) => note.noteFile === noteFile);
      const defaultExpanded = idx >= 0 && (idx < 2 || Boolean(results[idx].error));
      return { ...current, [noteFile]: !defaultExpanded };
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setInitialLoading(true);
    setInitialLoadIncomplete(false);
    setError(null);

    // F#7（🟠8）：先 await getMe（缓存在该链路命中/合并 in-flight），使 scope
    // 解析为真实 ws 键，随后批量 GET 全部落在带缓存路径（首帧冷缓存收益）。
    void (async () => {
      const account = await api.getMe().catch(() => null);
      if (cancelled) return;
      const batch = await Promise.allSettled([
        api.listBenchmarkNotes(),
        api.getBenchmarkReport(),
        api.getBenchmarkLabels(),
      ] as const);
      if (cancelled) return;
      const [notesResult, reportResult, labelsResult] = batch;

      const loadingErrors: string[] = [];
      if (notesResult.status === "fulfilled") {
        setSampleCount(notesResult.value.items.length);
      } else {
        loadingErrors.push("样本清单");
      }

      if (account) {
        setIsOwner(account.role.toLowerCase() === "owner");
      } else {
        setIsOwner(null);
        loadingErrors.push("账户权限");
      }

      if (reportResult.status === "fulfilled" && reportResult.value.report) {
        const latestReport = reportResult.value.report;
        setReport(latestReport);

        if (
          latestReport.hasLabels &&
          labelsResult.status === "fulfilled" &&
          labelsResult.value.labels.length > 0
        ) {
          setLabels(labelsFromSaved(labelsResult.value.labels));
          setPhase("labeled");
        } else {
          setLabels(labelsFromReport(latestReport));
          setPhase("reviewing");
          if (
            latestReport.hasLabels &&
            (labelsResult.status === "rejected" || labelsResult.value.labels.length === 0)
          ) {
            loadingErrors.push("历史人工标注");
          }
        }
      } else if (reportResult.status === "fulfilled") {
        setReport(null);
        setLabels({});
        setPhase("idle");
      } else if (reportResult.status === "rejected") {
        loadingErrors.push("历史报告");
      }

      setError(
        loadingErrors.length > 0
          ? `${loadingErrors.join("、")}暂时未能读取；已加载内容仍可使用。`
          : null,
      );
      setInitialLoadIncomplete(loadingErrors.length > 0);
      setInitialLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const handleRun = useCallback(async () => {
    if (isOwner !== true) return;
    setPhase("running");
    setInitialLoadIncomplete(false);
    setError(null);
    try {
      const result = await api.runBenchmark();
      setReport(result);
      setLabels(labelsFromReport(result));
      setExpandedNotes({});
      setPhase("reviewing");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "运行证据对齐测评失败");
      setPhase("failed");
    }
  }, [isOwner]);

  const handleSetVerdict = useCallback(
    (noteFile: string, ordinal: number, verdict: boolean) => {
      setLabels((current) => {
        const noteLabels = { ...current[noteFile] };
        const entry = noteLabels[ordinal];
        if (!entry) return current;
        noteLabels[ordinal] = {
          ...entry,
          isCorrectlyAligned: verdict,
          expectedBlockOrdinal: verdict ? null : entry.expectedBlockOrdinal,
        };
        return { ...current, [noteFile]: noteLabels };
      });
    },
    [],
  );

  const handleSetExpected = useCallback(
    (noteFile: string, ordinal: number, value: string) => {
      const parsed = value === "" ? null : Number.parseInt(value, 10);
      setLabels((current) => {
        const noteLabels = { ...current[noteFile] };
        const entry = noteLabels[ordinal];
        if (!entry) return current;
        noteLabels[ordinal] = {
          ...entry,
          expectedBlockOrdinal: parsed !== null && Number.isNaN(parsed) ? null : parsed,
        };
        return { ...current, [noteFile]: noteLabels };
      });
    },
    [],
  );

  const reviewProgress = useMemo(() => {
    if (!report) return { total: 0, reviewed: 0, correct: 0, complete: false };
    let total = 0;
    let reviewed = 0;
    let correct = 0;
    for (const note of report.results) {
      if (note.error) continue;
      for (const keyPoint of note.keyPoints) {
        total += 1;
        const verdict = labels[note.noteFile]?.[keyPoint.ordinal]?.isCorrectlyAligned;
        if (verdict !== null && verdict !== undefined) reviewed += 1;
        if (verdict === true) correct += 1;
      }
    }
    return { total, reviewed, correct, complete: total > 0 && reviewed === total };
  }, [labels, report]);

  const nextPendingTarget = useMemo<PendingReviewTarget | null>(() => {
    if (!report) return null;
    for (const [noteIndex, note] of report.results.entries()) {
      if (note.error) continue;
      const keyPoint = note.keyPoints.find(
        (item) => labels[note.noteFile]?.[item.ordinal]?.isCorrectlyAligned == null,
      );
      if (keyPoint) return { noteIndex, keyPointOrdinal: keyPoint.ordinal };
    }
    return null;
  }, [labels, report]);

  const scrollToReportTarget = useCallback((noteIndex: number, keyPointOrdinal?: number) => {
    const note = report?.results[noteIndex];
    if (!note) return;

    setExpandedNotes((current) => ({ ...current, [note.noteFile]: true }));
    const noteAnchor = `bench-note-${noteIndex + 1}`;
    // Preserve Next.js' route metadata; replacing it with null can break later
    // back/forward navigation even though only the hash is changing here.
    window.history.replaceState(window.history.state, "", `#${noteAnchor}`);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const targetId = keyPointOrdinal === undefined
          ? noteAnchor
          : `bench-keypoint-${noteIndex + 1}-${keyPointOrdinal}`;
        const target = document.getElementById(targetId) ?? document.getElementById(noteAnchor);
        target?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          block: "start",
        });
        if (keyPointOrdinal !== undefined) {
          target?.querySelector<HTMLButtonElement>(".bench-judgment-options button:not(:disabled)")
            ?.focus({ preventScroll: true });
        }
      });
    });
  }, [report]);

  const handleLocateNextPending = useCallback(() => {
    if (!nextPendingTarget) return;
    scrollToReportTarget(nextPendingTarget.noteIndex, nextPendingTarget.keyPointOrdinal);
  }, [nextPendingTarget, scrollToReportTarget]);

  const handleSubmitLabels = useCallback(async () => {
    if (!report || !reviewProgress.complete || isOwner !== true) return;
    setPhase("submittingLabels");
    setInitialLoadIncomplete(false);
    setError(null);
    try {
      const payload: BenchmarkLabel[] = Object.entries(labels).map(([noteFile, keyPoints]) => ({
        noteFile,
        keyPoints: Object.entries(keyPoints).map(([ordinal, entry]) => ({
          ordinal: Number.parseInt(ordinal, 10),
          isCorrectlyAligned: entry.isCorrectlyAligned === true,
          expectedBlockOrdinal: entry.expectedBlockOrdinal,
        })),
      }));
      const result = await api.saveBenchmarkLabels(report.runId, payload);
      setReport(result);
      setPhase("labeled");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "提交人工复核失败");
      setPhase("reviewing");
    }
  }, [isOwner, labels, report, reviewProgress.complete]);

  const stage = phasePresentation(phase);
  const isPreviousReport = Boolean(report && (phase === "running" || phase === "failed"));
  const failedNotes = report?.results.filter((note) => Boolean(note.error)).length ?? 0;
  const reportLabelsAvailable = phase === "labeled" || (isPreviousReport && report?.hasLabels === true);
  const verified = reportLabelsAvailable && report?.metrics.metricsVerified === true && failedNotes === 0;
  const currentStep =
    phase === "labeled"
      ? 3
      : phase === "reviewing" || phase === "submittingLabels"
        ? 2
        : 1;
  const showRunAction = phase === "failed" || phase === "labeled" || (phase === "reviewing" && failedNotes > 0);
  const showReviewDock =
    (phase === "reviewing" || phase === "submittingLabels") &&
    reviewProgress.total > 0 &&
    isOwner === true;

  return (
    <div className="benchmark-page">
      <PageHeader
        className="workspace-page-header"
        kicker="EVALUATION LAB · 内部测评"
        title="证据对齐测评"
        subtitle="运行内置样本、人工复核 Claim 与 Quote，再计算可信的硬引用 Precision。"
        actions={
          <div className="bench-header-actions">
            <Link href="/" className="bench-home-link" aria-label="返回学习流">
              <Icon.Chevron /><span>返回学习流</span>
            </Link>
            {showRunAction && isOwner === true && (
              <button
                type="button"
                className="bench-primary-button"
                onClick={() => void handleRun()}
                disabled={initialLoading}
              >
                <Icon.Play />
                {phase === "failed" ? "重新尝试" : report ? "运行新一轮" : "运行测评"}
              </button>
            )}
            <ThemeToggle className="benchmark-theme-toggle" />
          </div>
        }
      />

      <div className="benchmark-content">
        <section className={`bench-stage is-${phase}`} aria-labelledby="bench-stage-title">
          <div className="bench-stage-copy">
            <span className={`bench-phase-chip is-${phase}`}>
              <i aria-hidden="true" />{stage.label}
            </span>
            <h2 id="bench-stage-title">{stage.title}</h2>
            <p>{stage.description}</p>
          </div>
          <ol className="bench-stage-track" aria-label="测评流程">
            {[
              ["运行样本", "生成与对齐"],
              ["人工复核", "判断引用准确性"],
              ["计算结果", "形成最终判定"],
            ].map(([title, description], index) => {
              const step = index + 1;
              return (
                <li key={title} className={step < currentStep ? "is-done" : step === currentStep ? "is-current" : undefined}>
                  <span>{step < currentStep ? <Icon.Check /> : `0${step}`}</span>
                  <div><strong>{title}</strong><small>{description}</small></div>
                </li>
              );
            })}
          </ol>
        </section>

        {isOwner === false && (
          <div className="bench-notice is-permission" role="status">
            <Icon.Lock aria-hidden="true" />
            <div><strong>当前为只读测评视图</strong><span>只有工作区所有者可以运行测评和提交人工复核。</span></div>
          </div>
        )}

        {error && (
          <div className="bench-notice is-danger" role="alert">
            <Icon.Warn aria-hidden="true" />
            <div><strong>部分操作没有完成</strong><span>{error}</span></div>
            {initialLoadIncomplete && (
              <button
                type="button"
                className="bench-notice-action"
                onClick={() => setLoadAttempt((current) => current + 1)}
                disabled={initialLoading}
              >
                {initialLoading ? "正在重试" : "重新加载"}
              </button>
            )}
          </div>
        )}

        <div className="bench-layout">
          <aside className="bench-sidebar" aria-label="测评运行信息">
            <section className="bench-info-card">
              <span className="bench-info-eyebrow">基准配置</span>
              <h2>运行档案</h2>
              <dl className="bench-info-list">
                <div><dt>内置样本</dt><dd>{initialLoading ? "—" : sampleCount ?? "未知"}</dd></div>
                <div><dt>当前阶段</dt><dd><span className={`bench-info-state is-${phase}`}>{stage.label}</span></dd></div>
                {report && (
                  <>
                    <div><dt>数据集版本</dt><dd className="bench-mono">{report.datasetVersion}</dd></div>
                    <div><dt>运行编号</dt><dd className="bench-mono" title={report.runId}>{report.runId.slice(0, 8)}</dd></div>
                    <div><dt>关键结论</dt><dd>{report.totalKeyPoints}</dd></div>
                    <div><dt>失败样本</dt><dd className={failedNotes > 0 ? "is-danger" : undefined}>{failedNotes}</dd></div>
                  </>
                )}
              </dl>
            </section>

            {!report && (
              <section className="bench-info-card">
                <span className="bench-info-eyebrow">评测协议</span>
                <h2>测评边界</h2>
                <ul className="bench-protocol-list">
                  <li><Icon.Card /><span><strong>生成学习卡</strong><small>验证结论提取</small></span></li>
                  <li><Icon.Link /><span><strong>对齐原文</strong><small>核对逐字引用</small></span></li>
                  <li><Icon.Target /><span><strong>人工判定</strong><small>计算 Precision</small></span></li>
                </ul>
              </section>
            )}

            {report && (
              <nav className="bench-sample-nav" aria-label="报告样本目录">
                <span className="bench-info-eyebrow">样本索引</span>
                <h2>样本目录</h2>
                <div>
                  {report.results.map((note, index) => (
                    <a
                      key={note.noteFile}
                      href={`#bench-note-${index + 1}`}
                      onClick={(event) => {
                        event.preventDefault();
                        scrollToReportTarget(index);
                      }}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>{note.noteTitle}</strong>
                      {note.error ? <Icon.Warn /> : <Icon.Chevron />}
                    </a>
                  ))}
                </div>
              </nav>
            )}
          </aside>

          <section className="bench-main" aria-label="测评报告">
            {phase === "running" && (
              <div className="bench-running-card" aria-live="polite">
                <span className="bench-running-orbit" aria-hidden="true"><Icon.Bolt /></span>
                <div>
                  <span>基准测评进行中</span>
                  <h2>正在运行完整链路</h2>
                  <p>这是同步长任务，当前接口不提供虚假百分比。页面会在报告真正完成后自动切换。</p>
                  <div className="bench-running-line"><i /></div>
                </div>
              </div>
            )}

            {phase === "failed" && !report && (
              <div className="bench-failure-card">
                <span><Icon.Warn /></span>
                <h2>测评没有生成报告</h2>
                <p>确认 API 与 AI Worker 正常后重新运行；失败不会产生一份伪完成报告。</p>
                {isOwner === true && (
                  <button type="button" className="bench-primary-button" onClick={() => void handleRun()}>
                    <Icon.Refresh />重新运行
                  </button>
                )}
              </div>
            )}

            {phase === "idle" && !report && !initialLoading && (
              <div className="bench-launch-card">
                <div className="bench-launch-mark" aria-hidden="true"><Icon.Target /></div>
                <span className="bench-info-eyebrow">准备就绪</span>
                <h2>从真实链路开始，而不是从漂亮数字开始</h2>
                <p>运行会创建 {sampleCount ?? "全部"} 篇内置样本，经过学习卡生成与证据对齐，再进入人工复核。</p>
                <div className="bench-launch-flow" aria-label="测评执行流程">
                  <span>样本材料</span><Icon.Arrow /><span>学习卡</span><Icon.Arrow /><span>证据对齐</span><Icon.Arrow /><span>人工复核</span>
                </div>
                {isOwner === true ? (
                  <button type="button" className="bench-primary-button" onClick={() => void handleRun()}>
                    <Icon.Play />运行本轮测评
                  </button>
                ) : (
                  <div className="bench-readonly-hint" role="status">
                    <Icon.Lock aria-hidden="true" />
                    <span>{isOwner === false ? "等待工作区所有者运行测评" : "读取账户权限后即可运行"}</span>
                  </div>
                )}
              </div>
            )}

            {initialLoading && !report && (
              <div className="bench-initial-loading" aria-label="正在加载测评信息">
                <span /><span /><span />
              </div>
            )}

            {report && (
              <div className={`bench-report${isPreviousReport ? " is-previous" : ""}${showReviewDock ? " has-review-dock" : ""}`}>
                {isPreviousReport && (
                  <div className="bench-previous-banner">
                    <Icon.Archive />
                    <span>当前展示上一份完整报告；新运行成功前不会覆盖它。</span>
                  </div>
                )}

                <section className="bench-report-overview" aria-labelledby="bench-report-overview-title">
                  <div className="bench-report-heading">
                    <span>报告概览</span>
                    <h2 id="bench-report-overview-title">指标与退出判定</h2>
                    <p>{new Date(report.timestamp).toLocaleString("zh-CN")} · {report.totalNotes} 篇样本 · {report.totalKeyPoints} 条结论</p>
                  </div>
                  <div className={`bench-verdict ${verified && report.metrics.hardCitationPrecision !== null ? (report.metrics.hardCitationPrecision >= BENCHMARK_QUALITY_THRESHOLDS.hardCitationPrecision ? "is-pass" : "is-fail") : "is-pending"}`}>
                    <span>{failedNotes > 0 ? "运行未完成" : verified ? "退出判定" : "等待复核"}</span>
                    <strong>
                      {failedNotes > 0
                        ? "运行不完整"
                        : !verified || report.metrics.hardCitationPrecision === null
                        ? "待人工复核"
                        : report.metrics.hardCitationPrecision >= BENCHMARK_QUALITY_THRESHOLDS.hardCitationPrecision
                          ? "达到退出标准"
                          : "尚未达到标准"}
                    </strong>
                    <small>硬引用准确率 {report.metrics.hardCitationPrecision === null ? "尚未计算" : `${formatMetric(report.metrics.hardCitationPrecision)}%`} / 标准 90%</small>
                  </div>
                </section>

                <div className="bench-metrics">
                  <MetricCard label="硬引用准确率" code="硬引用准确率" value={report.metrics.hardCitationPrecision} threshold={BENCHMARK_QUALITY_THRESHOLDS.hardCitationPrecision} primary verified={verified} />
                  <MetricCard label="关键结论硬证据覆盖" code="关键结论覆盖" value={report.metrics.keyPointHardCoverage} threshold={BENCHMARK_QUALITY_THRESHOLDS.keyPointHardCoverage} verified={verified} />
                  <MetricCard label="期望位置硬证据覆盖" code="期望位置覆盖" value={report.metrics.validationExpectedPointsHardCoverage} threshold={BENCHMARK_QUALITY_THRESHOLDS.expectedBlockHardCoverage} verified={verified} />
                </div>

                {failedNotes > 0 && (
                  <div className="bench-notice is-danger" role="alert">
                    <Icon.Warn aria-hidden="true" />
                    <div><strong>{failedNotes} 个样本未完成，本轮不能形成退出结论</strong><span>可以复核已完成样本用于排查，但必须重新运行完整数据集后才能判定达标。</span></div>
                  </div>
                )}

                {!verified && (
                  <div className="bench-notice is-warning">
                    <Icon.Warn aria-hidden="true" />
                    <div><strong>当前指标尚未经过完整人工复核</strong><span>未确认的指标保持中性，不会提前显示为“达标”。</span></div>
                  </div>
                )}

                {(phase === "reviewing" || phase === "submittingLabels") && (
                  <section className="bench-review-progress" aria-label="人工复核进度">
                    <div>
                      <span>人工复核</span>
                      <h2>人工复核进度</h2>
                      <p>每条结论必须明确选择“准确”或“不准确”，未操作不会被当成错误。</p>
                    </div>
                    <div className="bench-review-progress-value">
                      <strong>{reviewProgress.reviewed}<i>/ {reviewProgress.total}</i></strong>
                      <span>已复核</span>
                    </div>
                    <div className="bench-review-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={reviewProgress.total} aria-valuenow={reviewProgress.reviewed}>
                      <span style={{ width: `${reviewProgress.total > 0 ? (reviewProgress.reviewed / reviewProgress.total) * 100 : 0}%` }} />
                    </div>
                  </section>
                )}

                {report.results.length > 0 && (
                  <nav className="bench-mobile-sample-nav" aria-label="快速跳转到测评样本">
                    <div>
                      {report.results.map((note, index) => {
                        const reviewed = note.keyPoints.filter(
                          (keyPoint) => labels[note.noteFile]?.[keyPoint.ordinal]?.isCorrectlyAligned != null,
                        ).length;
                        return (
                          <a
                            key={note.noteFile}
                            href={`#bench-note-${index + 1}`}
                            className={note.error ? "has-error" : undefined}
                            onClick={(event) => {
                              event.preventDefault();
                              scrollToReportTarget(index);
                            }}
                          >
                            <span>{String(index + 1).padStart(2, "0")}</span>
                            <strong>{note.noteTitle}</strong>
                            <small>{note.error ? "失败" : `${reviewed}/${note.keyPoints.length}`}</small>
                          </a>
                        );
                      })}
                    </div>
                  </nav>
                )}

                {showReviewDock && (
                  <div className="bench-submit-bar">
                    <div className="bench-submit-copy" aria-live="polite">
                      <span>{reviewProgress.complete ? <Icon.Check /> : <Icon.Target />}</span>
                      <p>
                        <strong>{reviewProgress.complete ? "所有结论均已复核" : `已复核 ${reviewProgress.reviewed}/${reviewProgress.total} · 还剩 ${reviewProgress.total - reviewProgress.reviewed} 条`}</strong>
                        <small>{reviewProgress.complete ? "现在可以提交并计算最终 Precision。" : "完成全部判断后才能提交，未操作项不会被误算。"}</small>
                      </p>
                    </div>
                    <div className="bench-submit-actions">
                      {!reviewProgress.complete && (
                        <button
                          type="button"
                          className="bench-secondary-button"
                          onClick={handleLocateNextPending}
                          disabled={!nextPendingTarget || phase === "submittingLabels"}
                        >
                          <Icon.Target />定位待复核
                        </button>
                      )}
                      <button
                        type="button"
                        className="bench-primary-button"
                        onClick={() => void handleSubmitLabels()}
                        disabled={!reviewProgress.complete || phase === "submittingLabels" || isOwner !== true}
                      >
                        {phase === "submittingLabels" ? <Icon.Refresh className="bench-spin" /> : <Icon.Check />}
                        {phase === "submittingLabels" ? "正在计算" : "提交复核并计算结果"}
                      </button>
                    </div>
                  </div>
                )}

                <div className="bench-note-stack">
                  {report.results.map((note, index) => (
                    <NoteSection
                      key={note.noteFile}
                      id={`bench-note-${index + 1}`}
                      index={index + 1}
                      note={note}
                      phase={phase}
                      canEdit={isOwner === true}
                      labels={labels[note.noteFile]}
                      expanded={expandedNotes[note.noteFile] ?? (index < 2 || Boolean(note.error))}
                      onToggle={toggleNote}
                      onSetVerdict={handleSetVerdict}
                      onSetExpected={handleSetExpected}
                    />
                  ))}
                </div>

                {phase === "labeled" && (
                  <div className="bench-complete-bar">
                    <span><Icon.Check /></span>
                    <div><strong>人工复核已经写入本轮报告</strong><p>最终指标与每条人工判断均保留在当前页面中。</p></div>
                    {isOwner === true && (
                      <button type="button" className="bench-secondary-button" onClick={() => void handleRun()}>
                        <Icon.Refresh />运行新一轮
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  code,
  value,
  threshold,
  primary = false,
  verified,
}: {
  label: string;
  code: string;
  value: number | null;
  threshold: number;
  primary?: boolean;
  verified: boolean;
}) {
  const passed = value !== null && value >= threshold;
  const width = value === null ? 0 : Math.max(0, Math.min(100, value * 100));
  const state = !verified || value === null ? "pending" : passed ? "pass" : "fail";

  return (
    <article className={`bench-metric-card is-${state}${primary ? " is-primary" : ""}`}>
      <div className="bench-metric-topline">
        <span>{code}</span>
        <small>{state === "pending" ? "待验证" : passed ? "达标" : "未达标"}</small>
      </div>
      <h3>{label}</h3>
      <strong>{formatMetric(value)}{value === null ? "" : "%"}</strong>
      <div className="bench-metric-track" aria-hidden="true"><span style={{ width: `${width}%` }} /></div>
      <p>目标阈值 ≥ {(threshold * 100).toFixed(0)}%</p>
    </article>
  );
}

// F12（round4）：NoteSection 用 memo 包裹——label 切换/展开状态变化时，
// 未受影响的笔记行不重渲（内部页，低危但成本极低）。
// F#7（🟠7）：labels 传"本篇切片"labels[note.noteFile] 而非整个 map——
// 任意一条判定只重建该 note 的切片，其它 NoteSection 的 labels prop 引用
// 不变，memo 真正生效，避免全量重渲。
const NoteSection = memo(function NoteSection({
  id,
  index,
  note,
  phase,
  canEdit,
  labels,
  expanded,
  onToggle,
  onSetVerdict,
  onSetExpected,
}: {
  id: string;
  index: number;
  note: BenchmarkReport["results"][number];
  phase: Phase;
  canEdit: boolean;
  /** 本篇笔记的关键结论判定切片（labels[note.noteFile]）。 */
  labels: Record<number, LabelEntry> | undefined;
  expanded: boolean;
  onToggle: (noteFile: string) => void;
  onSetVerdict: (noteFile: string, ordinal: number, verdict: boolean) => void;
  onSetExpected: (noteFile: string, ordinal: number, value: string) => void;
}) {
  const showReview = phase === "reviewing" || phase === "submittingLabels" || phase === "labeled";
  const editable = phase === "reviewing" && canEdit;
  const reviewedCount = note.keyPoints.filter(
    (keyPoint) => labels?.[keyPoint.ordinal]?.isCorrectlyAligned != null,
  ).length;

  return (
    <section id={id} className={`bench-note-section${note.error ? " has-error" : ""}`}>
      <button type="button" className="bench-note-header" onClick={() => onToggle(note.noteFile)} aria-expanded={expanded}>
        <span className="bench-note-index">{String(index).padStart(2, "0")}</span>
        <span className="bench-note-title-wrap">
          <strong>{note.noteTitle}</strong>
          <small>{note.blockCount} 个原文块 · {note.keyPoints.length} 条关键结论{note.error ? " · 处理失败" : ""}</small>
        </span>
        {showReview && !note.error && <span className="bench-note-review-count">{reviewedCount}/{note.keyPoints.length} 已复核</span>}
        <span className={`bench-note-chevron${expanded ? " is-open" : ""}`}><Icon.Chevron /></span>
      </button>

      {expanded && (
        <div className="bench-note-body">
          {note.error ? (
            <div className="bench-note-error"><Icon.Warn /><div><strong>该样本处理失败</strong><p>{note.error}</p></div></div>
          ) : note.keyPoints.length === 0 ? (
            <div className="bench-note-empty">这篇样本没有生成可复核的关键结论。</div>
          ) : (
            <div className="bench-keypoint-list">
              {note.keyPoints.map((keyPoint) => {
                const label = labels?.[keyPoint.ordinal];
                const verdict = label?.isCorrectlyAligned ?? null;
                return (
                  <article
                    key={keyPoint.ordinal}
                    id={`bench-keypoint-${index}-${keyPoint.ordinal}`}
                    className={`bench-keypoint${verdict === true ? " is-correct" : verdict === false ? " is-incorrect" : ""}`}
                  >
                    <header className="bench-keypoint-header">
                      <span className="bench-keypoint-order">KP {String(keyPoint.ordinal).padStart(2, "0")}</span>
                      <AlignmentChip alignment={keyPoint.alignment} />
                      <span className="bench-keypoint-score"><small>Score</small><strong>{keyPoint.alignmentScore}</strong></span>
                    </header>
                    <div className="bench-keypoint-compare">
                      <section>
                        <span>CLAIM · 结论</span>
                        <p>{keyPoint.claim}</p>
                      </section>
                      <section>
                        <span>QUOTE · 原文引用</span>
                        <blockquote>{keyPoint.quoteText || "未返回原文引用"}</blockquote>
                      </section>
                    </div>
                    <footer className="bench-keypoint-footer">
                      <div className="bench-keypoint-meta">
                        <span>方法 <strong>{keyPoint.alignmentMethod}</strong></span>
                        <span>原文块 <strong>{keyPoint.blockOrdinal ?? "—"}</strong></span>
                      </div>
                      {showReview && label && (
                        <div className="bench-judgment">
                          <span>人工判断</span>
                          <div className="bench-judgment-options" role="group" aria-label={`关键结论 ${keyPoint.ordinal} 引用是否准确`}>
                            <button type="button" className={verdict === true ? "is-active is-correct" : undefined} onClick={() => onSetVerdict(note.noteFile, keyPoint.ordinal, true)} disabled={!editable} aria-pressed={verdict === true}>
                              <Icon.Check />准确
                            </button>
                            <button type="button" className={verdict === false ? "is-active is-incorrect" : undefined} onClick={() => onSetVerdict(note.noteFile, keyPoint.ordinal, false)} disabled={!editable} aria-pressed={verdict === false}>
                              <Icon.Close />不准确
                            </button>
                          </div>
                          <label className="bench-expected-input">
                            <span>期望块</span>
                            <input
                              type="number"
                              value={label.expectedBlockOrdinal ?? ""}
                              onChange={(event) => onSetExpected(note.noteFile, keyPoint.ordinal, event.target.value)}
                              disabled={!editable || verdict !== false}
                              min={0}
                              max={Math.max(0, note.blockCount - 1)}
                              step={1}
                              inputMode="numeric"
                              aria-label={`关键结论 ${keyPoint.ordinal} 的期望原文块序号`}
                              placeholder="—"
                            />
                          </label>
                        </div>
                      )}
                    </footer>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
});
