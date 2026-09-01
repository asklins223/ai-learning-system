import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Building2,
  KeyRound,
  LoaderCircle,
  LogIn,
  RefreshCw,
  ShieldAlert,
  UserPlus,
} from "lucide-react";
import type {
  AILearnDesktopApiM2,
  RuntimeSnapshotV1,
  SessionContextV1,
  WorkspaceSummaryV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  decideBootstrapGatewayFailure,
  decideRuntimeGate,
  decideSessionGate,
  gateErrorPolicy,
  inspectDesktopContract,
  type AuthenticatedDesktopSession,
  type ReadyDesktopSession,
  type ReauthenticationDesktopSession,
} from "../app/desktop-gate";
import {
  createRequestMeta,
  RendererGatewayError,
  unwrapGatewayResult,
} from "../app/desktop-client";
import {
  subscribeGateInvalidation,
  type GateInvalidationCode,
} from "../app/gate-invalidation";
import {
  establishRequiredRuntimeSubscription,
  type RequiredRuntimeSubscription,
} from "../app/runtime-gate-subscription";
import { mediaAssetUrl, useLearningRoomManifest } from "../media/learning-room-manifest";
import type { SceneMotionMode } from "../scene/scene-motion";
import { DoorOpeningTransition, type DoorTheme } from "./DoorOpeningTransition";
import "./desktop-access-gate.css";

type RetryAction = "bootstrap" | "connect" | "reload" | null;

type BlockedView = {
  phase: "blocked";
  title: string;
  detail: string;
  retryAction: RetryAction;
  retryAfter?: string;
};

type GateView =
  | { phase: "loading"; title: string; detail: string }
  | BlockedView
  | { phase: "auth"; mode: "login" | "register" }
  | { phase: "reauth"; session: ReauthenticationDesktopSession | ReadyDesktopSession | null }
  | { phase: "workspace"; session: AuthenticatedDesktopSession; workspaces: WorkspaceSummaryV1[] }
  | { phase: "ready"; runtime: RuntimeSnapshotV1; session: ReadyDesktopSession };

type DoorEntryPhase = "closed" | "opening" | "open";

const initialView: GateView = {
  phase: "loading",
  title: "正在确认桌面环境",
  detail: "先验证本机桥接、学习服务与工作区，再进入理解书房。",
};

function desktopApi(): AILearnDesktopApiM2 | null {
  const value = (window as unknown as { ailearn?: AILearnDesktopApiM2 }).ailearn;
  if (!value || typeof value !== "object") return null;
  if (
    typeof value.runtime?.getSnapshot !== "function"
    || typeof value.runtime?.retryApiConnection !== "function"
    || typeof value.auth?.getState !== "function"
    || typeof value.auth?.login !== "function"
    || typeof value.auth?.register !== "function"
    || typeof value.auth?.reauthenticate !== "function"
    || typeof value.workspace?.list !== "function"
    || typeof value.workspace?.switch !== "function"
    || typeof value.subscriptions?.subscribe !== "function"
    || typeof value.subscriptions?.onEvent !== "function"
    || typeof value.subscriptions?.unsubscribe !== "function"
  ) return null;
  return value;
}

function blockedFromError(error: unknown, title: string): BlockedView {
  const policy = gateErrorPolicy(error, title);
  const reconnect = error instanceof RendererGatewayError
    && (error.code === "api_unavailable" || error.code === "network_timeout");
  const retryAction = policy.retry === "safe_retry"
    ? reconnect ? "connect" : "bootstrap"
    : policy.retry === "resync_first"
      ? "bootstrap"
      : null;
  return {
    phase: "blocked",
    title: policy.title,
    detail: policy.detail,
    retryAction,
    ...(policy.retryAfter ? { retryAfter: policy.retryAfter } : {}),
  };
}

function retryTimeLabel(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return null;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function GateFrame({
  title,
  detail,
  tone = "default",
  entryPosterUrl,
  children,
}: {
  title: string;
  detail: string;
  tone?: "default" | "danger";
  entryPosterUrl: string | null;
  children?: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const style = entryPosterUrl
    ? ({ "--desktop-gate-entry-poster": `url("${entryPosterUrl}")` } as CSSProperties)
    : undefined;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [title]);

  return (
    <main
      id="main-content"
      className="desktop-access-gate"
      data-tone={tone}
      data-gate-asset-source={entryPosterUrl ? "manifest" : "fallback"}
      style={style}
    >
      <div className="desktop-access-gate__drag-region" aria-hidden="true" />
      <section className="desktop-access-gate__panel" aria-labelledby="desktop-gate-title" aria-describedby="desktop-gate-detail">
        <div className="desktop-access-gate__heading">
          <h1 ref={headingRef} id="desktop-gate-title" tabIndex={-1}>{title}</h1>
          <p id="desktop-gate-detail">{detail}</p>
        </div>
        {children}
      </section>
    </main>
  );
}

export function DesktopAccessGate({
  children,
  onWorkspaceBoundaryReset,
  theme = "day",
  motionMode = "full",
}: {
  children: ReactNode;
  onWorkspaceBoundaryReset?: () => void;
  theme?: DoorTheme;
  motionMode?: SceneMotionMode;
}) {
  const [view, setView] = useState<GateView>(initialView);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [formBusy, setFormBusy] = useState(false);
  const [formFailure, setFormFailure] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [doorEntryPhase, setDoorEntryPhase] = useState<DoorEntryPhase>("closed");
  const { manifest: roomManifest, error: roomManifestError } = useLearningRoomManifest();
  const gateEntryPosterUrl = roomManifest
    ? mediaAssetUrl(roomManifest, roomManifest.entryPosters.closed[theme].path)
    : null;
  const generationRef = useRef(0);
  const forceConnectionRef = useRef(false);
  const connectionFlightRef = useRef<Promise<unknown> | null>(null);
  const readyBoundaryRef = useRef<string | null>(null);
  const lastTrustedSessionRef = useRef<ReadyDesktopSession | null>(null);
  const viewPhaseRef = useRef<GateView["phase"]>(initialView.phase);
  viewPhaseRef.current = view.phase;

  const beginDoorEntry = useCallback(() => {
    const canAnimate = motionMode !== "off" && Boolean(roomManifest) && !roomManifestError;
    setDoorEntryPhase(canAnimate ? "opening" : "open");
  }, [motionMode, roomManifest, roomManifestError]);

  const completeDoorEntry = useCallback(() => {
    setDoorEntryPhase("open");
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("ailearn:desktop-room-entry-complete"));
    });
  }, []);

  useEffect(() => {
    if (view.phase !== "ready" && doorEntryPhase === "open") {
      setDoorEntryPhase("closed");
    }
  }, [doorEntryPhase, view.phase]);

  const requestBootstrap = useCallback((forceConnection = false) => {
    generationRef.current += 1;
    forceConnectionRef.current = forceConnectionRef.current || forceConnection;
    setFormFailure(null);
    setView({
      phase: "loading",
      title: forceConnection ? "正在重新验证学习服务" : "正在同步桌面状态",
      detail: "连接、身份和工作区都确认无误后才会重新开放理解书房。",
    });
    setRefreshRevision((revision) => revision + 1);
  }, []);

  const invalidateReadyGate = useCallback((code?: GateInvalidationCode) => {
    if (viewPhaseRef.current !== "ready") return;
    onWorkspaceBoundaryReset?.();
    readyBoundaryRef.current = null;
    if (["auth_required", "api_untrusted", "configuration_error", "unsupported_contract"].includes(code ?? "")) {
      lastTrustedSessionRef.current = null;
    }
    requestBootstrap(code === undefined);
  }, [onWorkspaceBoundaryReset, requestBootstrap]);

  useEffect(() => subscribeGateInvalidation((code) => invalidateReadyGate(code)), [invalidateReadyGate]);

  const connectOnce = useCallback(async (api: AILearnDesktopApiM2) => {
    if (!connectionFlightRef.current) {
      const flight = api.runtime
        .retryApiConnection({ meta: createRequestMeta() })
        .then((response) => unwrapGatewayResult(response));
      connectionFlightRef.current = flight;
      void flight.finally(() => {
        if (connectionFlightRef.current === flight) connectionFlightRef.current = null;
      }).catch(() => undefined);
    }
    return connectionFlightRef.current;
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    let waitTimer: number | undefined;
    let runtimeSubscription: RequiredRuntimeSubscription | null = null;
    const isCurrent = () => generationRef.current === generation;
    const apply = (next: GateView) => {
      if (!isCurrent()) return;
      if (next.phase === "ready") {
        const nextBoundary = [
          next.session.user.userId,
          next.session.workspace.workspaceId,
          next.session.workspaceEpoch,
        ].join(":");
        if (readyBoundaryRef.current !== null && readyBoundaryRef.current !== nextBoundary) {
          onWorkspaceBoundaryReset?.();
        }
        readyBoundaryRef.current = nextBoundary;
        lastTrustedSessionRef.current = next.session;
      }
      setView(next);
    };

    const bootstrap = async () => {
      const api = desktopApi();
      if (!api) {
        apply({
          phase: "blocked",
          title: "桌面桥接没有加载",
          detail: "当前窗口无法访问经过主进程校验的桌面 API。重新载入后仍失败时，请重新启动客户端。",
          retryAction: "reload",
        });
        return;
      }
      const contractDecision = inspectDesktopContract(api.contract);
      if (contractDecision.kind === "blocked") {
        apply({
          phase: "blocked",
          title: "桌面合同不兼容",
          detail: contractDecision.detail,
          retryAction: null,
        });
        return;
      }

      try {
        try {
          const subscription = await establishRequiredRuntimeSubscription(api, createRequestMeta(), (event) => {
            if (!isCurrent() || viewPhaseRef.current !== "ready") return;
            if (event.data.kind === "connection_changed" && event.data.state.kind !== "ready") {
              const decision = decideRuntimeGate(event.data.state);
              if (decision.kind === "blocked") {
                onWorkspaceBoundaryReset?.();
                readyBoundaryRef.current = null;
                generationRef.current += 1;
                setView({
                  phase: "blocked",
                  title: decision.title,
                  detail: decision.detail,
                  retryAction: decision.retry === "safe_retry" ? "connect" : null,
                  ...(decision.connection.kind === "api_unavailable" && decision.connection.retryAfter
                    ? { retryAfter: decision.connection.retryAfter }
                    : {}),
                });
                return;
              }
            }
            invalidateReadyGate();
          });
          if (!isCurrent()) {
            subscription.close();
            return;
          }
          runtimeSubscription = subscription;
        } catch (error) {
          if (!isCurrent()) return;
          const blocked = blockedFromError(error, "无法监听桌面状态");
          apply({ ...blocked, retryAction: blocked.retryAction ?? "bootstrap" });
          return;
        }

        let runtime = unwrapGatewayResult(await api.runtime.getSnapshot({ meta: createRequestMeta() }));
        if (!isCurrent()) return;
        let runtimeDecision = decideRuntimeGate(runtime.apiConnection);
        const forceConnection = forceConnectionRef.current;
        forceConnectionRef.current = false;

        if (runtimeDecision.kind === "connect" || forceConnection) {
          apply({
            phase: "loading",
            title: "正在验证学习服务",
            detail: "主进程正在校验服务身份、合同版本与本机配对签名。",
          });
          await connectOnce(api);
          if (!isCurrent()) return;
          runtime = unwrapGatewayResult(await api.runtime.getSnapshot({ meta: createRequestMeta() }));
          runtimeDecision = decideRuntimeGate(runtime.apiConnection);
        }

        if (runtimeDecision.kind === "connect") {
          apply({
            phase: "loading",
            title: "学习服务仍在校验",
            detail: "校验完成前不会读取身份或工作区数据。",
          });
          waitTimer = window.setTimeout(() => requestBootstrap(), 650);
          return;
        }

        if (runtimeDecision.kind === "blocked") {
          apply({
            phase: "blocked",
            title: runtimeDecision.title,
            detail: runtimeDecision.detail,
            retryAction: runtimeDecision.retry === "safe_retry" ? "connect" : null,
            ...(runtimeDecision.connection.kind === "api_unavailable" && runtimeDecision.connection.retryAfter
              ? { retryAfter: runtimeDecision.connection.retryAfter }
              : {}),
          });
          return;
        }

        apply({
          phase: "loading",
          title: "正在确认登录身份",
          detail: "只接受主进程返回的真实会话与当前工作区。",
        });
        const session = unwrapGatewayResult(await api.auth.getState({ meta: createRequestMeta() }));
        if (!isCurrent()) return;
        const sessionDecision = decideSessionGate(session);

        switch (sessionDecision.kind) {
          case "wait":
            apply({
              phase: "loading",
              title: sessionDecision.reason === "restoring" ? "正在恢复登录" : "正在切换工作区",
              detail: "会话完成前，理解书房保持关闭。",
            });
            waitTimer = window.setTimeout(() => requestBootstrap(), 700);
            return;
          case "authenticate":
            apply({ phase: "auth", mode: "login" });
            return;
          case "reauthenticate":
            apply({ phase: "reauth", session: sessionDecision.session });
            return;
          case "blocked":
            apply({
              phase: "blocked",
              title: sessionDecision.reason === "api_untrusted" ? "身份服务不受信任" : "身份服务暂时不可用",
              detail: sessionDecision.detail,
              retryAction: sessionDecision.reason === "api_unavailable" ? "connect" : null,
            });
            return;
          case "resync":
            apply({
              phase: "blocked",
              title: "工作区状态需要重新同步",
              detail: sessionDecision.detail,
              retryAction: "bootstrap",
            });
            return;
          case "workspace_required": {
            apply({
              phase: "loading",
              title: "正在读取可用工作区",
              detail: "选择将决定后续所有学习数据的隔离范围。",
            });
            const response = await api.workspace.list({ meta: createRequestMeta(sessionDecision.session.workspaceEpoch) });
            const workspaces = unwrapGatewayResult(response).workspaces;
            apply({ phase: "workspace", session: sessionDecision.session, workspaces });
            return;
          }
          case "ready":
            apply({ phase: "ready", runtime, session: sessionDecision.session });
            return;
        }
      } catch (error) {
        if (!isCurrent()) return;
        const failureDecision = decideBootstrapGatewayFailure(error);
        switch (failureDecision.kind) {
          case "authenticate":
            apply({ phase: "auth", mode: "login" });
            return;
          case "reauthenticate":
            apply({ phase: "reauth", session: lastTrustedSessionRef.current });
            return;
          case "resync":
          case "blocked":
            apply(blockedFromError(error, "无法确认桌面状态"));
            return;
        }
      }
    };

    void bootstrap();
    return () => {
      if (waitTimer !== undefined) window.clearTimeout(waitTimer);
      runtimeSubscription?.close();
    };
  }, [connectOnce, invalidateReadyGate, onWorkspaceBoundaryReset, refreshRevision, requestBootstrap]);

  useEffect(() => {
    if (view.phase !== "ready") return;
    const api = desktopApi();
    if (!api) return;
    let active = true;
    let subscriptionId: string | null = null;
    let stopEvents: (() => void) | undefined;

    const subscribe = async () => {
      try {
        const response = await api.subscriptions.subscribe({
          meta: createRequestMeta(view.session.workspaceEpoch),
          topic: { kind: "workspace" },
        });
        if (!active) return;
        subscriptionId = unwrapGatewayResult(response).subscriptionId;
        stopEvents = api.subscriptions.onEvent(subscriptionId, () => requestBootstrap());
      } catch (error) {
        if (active) setView(blockedFromError(error, "无法监听工作区状态"));
      }
    };

    void subscribe();
    return () => {
      active = false;
      stopEvents?.();
      if (subscriptionId) {
        void api.subscriptions.unsubscribe({
          meta: createRequestMeta(view.session.workspaceEpoch),
          subscriptionId,
        }).catch(() => undefined);
      }
    };
  }, [requestBootstrap, view]);

  useEffect(() => {
    if (view.phase !== "ready") return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") requestBootstrap();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [requestBootstrap, view.phase]);

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const api = desktopApi();
    if (!api || view.phase !== "auth") return;
    setFormBusy(true);
    setFormFailure(null);
    try {
      const response = view.mode === "login"
        ? await api.auth.login({ meta: createRequestMeta(), email, password, remember: false })
        : await api.auth.register({
            meta: createRequestMeta(),
            email,
            password,
            remember: false,
            ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
            ...(inviteToken.trim() ? { inviteToken: inviteToken.trim() } : {}),
          });
      unwrapGatewayResult(response);
      setPassword("");
      beginDoorEntry();
      requestBootstrap();
    } catch (error) {
      const policy = gateErrorPolicy(error, view.mode === "login" ? "无法登录" : "无法创建账号");
      if (error instanceof RendererGatewayError && ["api_unavailable", "network_timeout", "api_untrusted", "configuration_error", "unsupported_contract"].includes(error.code)) {
        setView(blockedFromError(error, policy.title));
      } else {
        setFormFailure(policy.detail);
      }
    } finally {
      setFormBusy(false);
    }
  };

  const handleReauthenticate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const api = desktopApi();
    if (!api || view.phase !== "reauth") return;
    setFormBusy(true);
    setFormFailure(null);
    try {
      const response = await api.auth.reauthenticate({ meta: createRequestMeta(), password });
      unwrapGatewayResult(response);
      setPassword("");
      beginDoorEntry();
      requestBootstrap();
    } catch (error) {
      const policy = gateErrorPolicy(error, "无法重新验证身份");
      if (error instanceof RendererGatewayError && ["api_unavailable", "network_timeout", "api_untrusted", "configuration_error", "unsupported_contract"].includes(error.code)) {
        setView(blockedFromError(error, policy.title));
      } else {
        setFormFailure(policy.detail);
      }
    } finally {
      setFormBusy(false);
    }
  };

  const handleWorkspaceSwitch = async (workspaceId: string) => {
    const api = desktopApi();
    if (!api || view.phase !== "workspace") return;
    setFormBusy(true);
    setFormFailure(null);
    try {
      const response = await api.workspace.switch({
        meta: createRequestMeta(view.session.workspaceEpoch),
        workspaceId,
      });
      unwrapGatewayResult(response);
      beginDoorEntry();
      requestBootstrap();
    } catch (error) {
      const policy = gateErrorPolicy(error, "无法切换工作区");
      if (policy.retry === "resync_first") {
        requestBootstrap();
      } else {
        setFormFailure(policy.detail);
      }
    } finally {
      setFormBusy(false);
    }
  };

  if (view.phase === "ready") {
    if (doorEntryPhase === "opening") {
      return <>
        <div
          className="desktop-access-gate__room-content"
          data-door-entry-phase={doorEntryPhase}
          aria-hidden="true"
          inert
        >
          {children}
        </div>
        <DoorOpeningTransition
          theme={theme}
          motionMode={motionMode}
          manifest={roomManifest}
          manifestError={roomManifestError}
          onComplete={completeDoorEntry}
        />
      </>;
    }
    return (
      <div className="desktop-access-gate__room-content" data-door-entry-phase={doorEntryPhase}>
        {children}
      </div>
    );
  }

  if (view.phase === "loading") {
    return (
      <GateFrame title={view.title} detail={view.detail} entryPosterUrl={gateEntryPosterUrl}>
        <div className="desktop-access-gate__loading" role="status" aria-live="polite">
          <LoaderCircle size={24} aria-hidden="true" />
          <span>正在安全检查</span>
        </div>
      </GateFrame>
    );
  }

  if (view.phase === "blocked") {
    const retryAt = retryTimeLabel(view.retryAfter);
    return (
      <GateFrame title={view.title} detail={view.detail} tone="danger" entryPosterUrl={gateEntryPosterUrl}>
        <div className="desktop-access-gate__notice" role="alert">
          <ShieldAlert size={21} aria-hidden="true" />
          <span>{retryAt ? `服务建议在 ${retryAt} 后重新检查。` : "当前没有经过验证的工作区内容可显示。"}</span>
        </div>
        {view.retryAction ? (
          <button
            className="desktop-access-gate__primary"
            type="button"
            onClick={() => view.retryAction === "reload" ? window.location.reload() : requestBootstrap(view.retryAction === "connect")}
          >
            <RefreshCw size={17} aria-hidden="true" />
            {view.retryAction === "reload" ? "重新载入客户端" : view.retryAction === "connect" ? "重新验证连接" : "重新同步状态"}
          </button>
        ) : null}
      </GateFrame>
    );
  }

  if (view.phase === "auth") {
    const registering = view.mode === "register";
    return (
      <GateFrame
        title={registering ? "创建学习账号" : "推门进入理解书房"}
        detail={registering ? "账号建立成功后，再由服务端确认你的工作区。" : "验证后开门；登录经主进程提交，渲染层不存密码。"}
        entryPosterUrl={gateEntryPosterUrl}
      >
        <form className="desktop-access-gate__form" onSubmit={handleAuthSubmit}>
          {registering ? (
            <label>
              <span>显示名称</span>
              <input autoComplete="name" maxLength={200} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
          ) : null}
          <label>
            <span>邮箱</span>
            <input type="email" autoComplete="email" maxLength={320} required value={email} placeholder="name@example.com" onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            <span>密码</span>
            <input type="password" autoComplete={registering ? "new-password" : "current-password"} maxLength={200} required value={password} placeholder="输入密码" onChange={(event) => setPassword(event.target.value)} />
          </label>
          {registering ? (
            <label>
              <span>邀请令牌 <small>可选</small></span>
              <input type="password" autoComplete="off" maxLength={200} value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} />
            </label>
          ) : null}
          {formFailure ? <p className="desktop-access-gate__form-error" role="alert">{formFailure}</p> : null}
          <button className="desktop-access-gate__primary" type="submit" disabled={formBusy}>
            {registering ? <UserPlus size={17} aria-hidden="true" /> : <LogIn size={17} aria-hidden="true" />}
            {formBusy ? "正在提交…" : registering ? "创建账号并继续" : "登录并继续"}
            {!formBusy ? <ArrowRight size={16} aria-hidden="true" /> : null}
          </button>
          <button
            className="desktop-access-gate__text-action"
            type="button"
            disabled={formBusy}
            onClick={() => {
              setFormFailure(null);
              setPassword("");
              setView({ phase: "auth", mode: registering ? "login" : "register" });
            }}
          >
            {registering ? "已有账号，返回登录" : "没有账号，创建一个"}
          </button>
        </form>
      </GateFrame>
    );
  }

  if (view.phase === "reauth") {
    const accountLabel = view.session?.user?.displayName ?? view.session?.user?.email ?? "当前账号";
    return (
      <GateFrame title="请重新验证身份" detail={`${accountLabel} 的会话需要再次确认，验证完成前工作区保持关闭。`} entryPosterUrl={gateEntryPosterUrl}>
        <form className="desktop-access-gate__form" onSubmit={handleReauthenticate}>
          <label>
            <span>当前密码</span>
            <input type="password" autoComplete="current-password" maxLength={200} required value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {formFailure ? <p className="desktop-access-gate__form-error" role="alert">{formFailure}</p> : null}
          <button className="desktop-access-gate__primary" type="submit" disabled={formBusy}>
            <KeyRound size={17} aria-hidden="true" />
            {formBusy ? "正在验证…" : "重新验证并继续"}
          </button>
        </form>
      </GateFrame>
    );
  }

  return (
    <GateFrame
      title="选择要进入的工作区"
      detail={`已验证 ${view.session.user?.email ?? "当前账号"}；选择后，所有学习数据都会绑定到新的工作区版本。`}
      entryPosterUrl={gateEntryPosterUrl}
    >
      {view.workspaces.length ? (
        <div className="desktop-access-gate__workspace-list" aria-label="可用工作区">
          {view.workspaces.map((workspace) => (
            <button
              key={workspace.workspaceId}
              type="button"
              disabled={formBusy}
              onClick={() => void handleWorkspaceSwitch(workspace.workspaceId)}
            >
              <Building2 size={20} aria-hidden="true" />
              <span>
                <strong>{workspace.name}</strong>
                <small>{workspace.isPersonal ? "个人工作区" : "协作工作区"} · {workspace.role === "owner" ? "所有者" : "成员"}</small>
              </span>
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <div className="desktop-access-gate__empty" role="status">
          <Building2 size={24} aria-hidden="true" />
          <strong>当前账号没有可进入的工作区</strong>
          <p>客户端不会创建本地替代工作区。请先在服务端完成工作区分配。</p>
        </div>
      )}
      {formFailure ? <p className="desktop-access-gate__form-error" role="alert">{formFailure}</p> : null}
      <button className="desktop-access-gate__text-action" type="button" disabled={formBusy} onClick={() => requestBootstrap()}>
        <RefreshCw size={15} aria-hidden="true" />重新读取工作区
      </button>
    </GateFrame>
  );
}
