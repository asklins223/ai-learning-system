import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import type { GatewayEventV1, SubscriptionTopicM2 } from "@ailearn/shared/desktop-ipc-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "./desktop-client";
import { useRoomStore } from "./room-store";
import {
  beginProjectionRefresh,
  failProjectionRefresh,
  projectionResponseIsCurrent,
  sameProjectionScope,
  type ProjectionWorkspaceScope,
} from "./workspace-projection";

type HomeProjectionState = {
  projection: RoomProjectionV1 | null;
  loading: boolean;
  failure: string | null;
  reload: () => void;
};

const HomeProjectionContext = createContext<HomeProjectionState>({
  projection: null, loading: true, failure: null, reload: () => {},
});

type ProjectionInvalidationSignal = {
  readonly revision: number;
  readonly workspaceEpoch: number | null;
};

const ProjectionInvalidationContext = createContext<ProjectionInvalidationSignal>({
  revision: 0,
  workspaceEpoch: null,
});

function scopeFromSession(session: {
  readonly workspaceEpoch: number;
  readonly workspace: { readonly workspaceId: string } | null;
}): ProjectionWorkspaceScope | null {
  return session.workspace
    ? { workspaceId: session.workspace.workspaceId, workspaceEpoch: session.workspaceEpoch }
    : null;
}

function isProjectionInvalidation(event: GatewayEventV1): boolean {
  // companion_activity_changed = 收件箱多了一条投递。主动念头气泡（proactiveCue）
  // 由伴星小屋投影渲染，而它是**惰性读**：没有这次失效，worker 送来的念头要等到
  // 用户切页面/手动刷新才看得见，而投递 2 小时就过期——体感就是"从不主动提醒"。
  return event.data.kind === "snapshot_invalidated"
    || event.data.kind === "connection_changed"
    || event.data.kind === "companion_activity_changed";
}

/** One authenticated read feeds the room's bookmark, shortcuts and recovery shelf. */
export function HomeProjectionProvider({ children }: { children: ReactNode }) {
  const surface = useRoomStore((state) => state.surface);
  const requestGenerationRef = useRef(0);
  const scopeRef = useRef<ProjectionWorkspaceScope | null>(null);
  const [signal, setSignal] = useState<ProjectionInvalidationSignal>({
    revision: 0,
    workspaceEpoch: null,
  });
  const [state, setState] = useState<Omit<HomeProjectionState, "reload">>({
    projection: null, loading: true, failure: null,
  });

  const invalidate = useCallback((workspaceEpoch: number | null = null) => {
    requestGenerationRef.current += 1;
    const knownScope = scopeRef.current;
    const crossedWorkspace = Boolean(
      knownScope && workspaceEpoch !== null && workspaceEpoch !== knownScope.workspaceEpoch,
    );
    if (crossedWorkspace) scopeRef.current = null;
    setState((current) => crossedWorkspace
      ? { projection: null, loading: true, failure: null }
      : beginProjectionRefresh(current, knownScope));
    setSignal((current) => ({ revision: current.revision + 1, workspaceEpoch }));
  }, []);
  const reload = useCallback(() => invalidate(), [invalidate]);

  useEffect(() => {
    if (surface || !window.ailearn) return;
    let active = true;
    const cleanups: Array<() => void> = [];
    const api = window.ailearn;

    const subscribe = async (topic: SubscriptionTopicM2) => {
      const response = await api.subscriptions.subscribe({ meta: createRequestMeta(), topic });
      const subscription = unwrapGatewayResult(response);
      if (!active) {
        void api.subscriptions.unsubscribe({
          meta: createRequestMeta(),
          subscriptionId: subscription.subscriptionId,
        }).catch(() => {});
        return;
      }
      const stop = api.subscriptions.onEvent(subscription.subscriptionId, (event) => {
        if (isProjectionInvalidation(event)) {
          invalidate(event.workspaceEpoch > 0 ? event.workspaceEpoch : null);
        }
      });
      cleanups.push(stop, () => {
        void api.subscriptions.unsubscribe({
          meta: createRequestMeta(),
          subscriptionId: subscription.subscriptionId,
        }).catch(() => {});
      });
    };

    void subscribe({ kind: "runtime" }).catch(() => {
      // Returning to the room and manual refresh also revalidate.
    });
    void subscribe({ kind: "workspace" }).catch(() => {
      // Auth bootstrap still detects a workspace boundary if the stream is unavailable.
    });
    return () => {
      active = false;
      for (const cleanup of cleanups) cleanup();
    };
  }, [invalidate, surface]);

  useEffect(() => {
    if (surface) {
      requestGenerationRef.current += 1;
      return;
    }
    const generation = ++requestGenerationRef.current;
    setState((current) => beginProjectionRefresh(current, scopeRef.current));
    const load = async () => {
      if (!window.ailearn) throw new Error("unavailable");
      const knownScope = scopeRef.current;
      /**
       * 同代刷新不重读会话：伴星投递这类失效说的是"这份投影旧了"，账号与空间都没
       * 变——上一次已经确认过的 (workspaceId, epoch) 就是答案。每来一条就 /auth/me
       * 一次，请求数会随事件条数线性增长（F01 的 1047 次/小时里有这一份）。
       */
      let requestScope: ProjectionWorkspaceScope | null;
      if (knownScope && signal.workspaceEpoch === knownScope.workspaceEpoch) {
        requestScope = knownScope;
      } else {
        const sessionResponse = await window.ailearn.auth.getState({ meta: createRequestMeta() });
        const session = unwrapGatewayResult(sessionResponse);
        if (session.status !== "authenticated" || !session.workspace) {
          if (generation === requestGenerationRef.current) {
            scopeRef.current = null;
            setState({ projection: null, loading: false, failure: "请先登录后再读取学习空间。" });
          }
          return;
        }
        requestScope = scopeFromSession(session);
      }

      if (!requestScope || generation !== requestGenerationRef.current) return;
      const previousScope = scopeRef.current;
      if (!sameProjectionScope(previousScope, requestScope)) {
        scopeRef.current = requestScope;
        setState((current) => beginProjectionRefresh(current, previousScope, requestScope));
      } else {
        scopeRef.current = requestScope;
      }

      const response = await window.ailearn.room.getProjection({
        meta: createRequestMeta(requestScope.workspaceEpoch),
      });
      const projection = unwrapGatewayResult(response);
      if (
        generation !== requestGenerationRef.current
        || !sameProjectionScope(requestScope, scopeRef.current)
      ) return;
      if (
        projection.workspaceEpoch !== requestScope.workspaceEpoch
        || (response.workspaceEpoch !== undefined && response.workspaceEpoch !== requestScope.workspaceEpoch)
      ) throw new Error("workspace changed");
      if (!projectionResponseIsCurrent(
        generation,
        requestGenerationRef.current,
        requestScope,
        scopeRef.current,
        response.workspaceEpoch,
      )) return;
      setState({ projection, loading: false, failure: null });
    };
    void load().catch((error) => {
      if (generation !== requestGenerationRef.current) return;
      setState((current) => failProjectionRefresh(current, gatewayErrorMessage(error)));
    });
    return () => {
      if (requestGenerationRef.current === generation) requestGenerationRef.current += 1;
    };
  }, [signal.revision, surface]);

  const value = useMemo(() => ({ ...state, reload }), [reload, state]);
  return (
    <ProjectionInvalidationContext.Provider value={signal}>
      <HomeProjectionContext.Provider value={value}>{children}</HomeProjectionContext.Provider>
    </ProjectionInvalidationContext.Provider>
  );
}

export const useHomeProjection = () => useContext(HomeProjectionContext);

/** Companion home data shares the exact same workspace/runtime invalidation boundary. */
export const useHomeProjectionInvalidation = () => useContext(ProjectionInvalidationContext);
