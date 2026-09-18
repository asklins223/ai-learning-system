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
import type { CapabilityProjectionV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "./desktop-client";
import { useHomeProjectionInvalidation } from "./home-projection";
import { useRoomStore } from "./room-store";
import {
  beginProjectionRefresh,
  failProjectionRefresh,
  projectionResponseIsCurrent,
  sameProjectionScope,
  type ProjectionWorkspaceScope,
} from "./workspace-projection";

export type HomeCapabilityProjectionState = Readonly<{
  projection: CapabilityProjectionV1 | null;
  loading: boolean;
  failure: string | null;
  reload: () => void;
}>;

const HomeCapabilityProjectionContext = createContext<HomeCapabilityProjectionState>({
  projection: null,
  loading: true,
  failure: null,
  reload: () => {},
});

/**
 * Keeps the server capability projection on the same workspace invalidation
 * boundary as RoomProjectionV1. A failed refresh retains a same-scope snapshot;
 * crossing workspace epochs clears it before any new response can render.
 */
export function HomeCapabilityProjectionProvider({ children }: { readonly children: ReactNode }) {
  const surface = useRoomStore((state) => state.surface);
  const invalidation = useHomeProjectionInvalidation();
  const requestGenerationRef = useRef(0);
  const scopeRef = useRef<ProjectionWorkspaceScope | null>(null);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<Omit<HomeCapabilityProjectionState, "reload">>({
    projection: null,
    loading: true,
    failure: null,
  });
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (surface) {
      requestGenerationRef.current += 1;
      return;
    }

    const knownScope = scopeRef.current;
    if (
      knownScope
      && invalidation.workspaceEpoch !== null
      && invalidation.workspaceEpoch !== knownScope.workspaceEpoch
    ) {
      scopeRef.current = null;
      setState({ projection: null, loading: true, failure: null });
    } else {
      setState((current) => beginProjectionRefresh(current, knownScope));
    }

    const generation = ++requestGenerationRef.current;
    const load = async () => {
      if (!window.ailearn) throw new Error("unavailable");
      const sessionResponse = await window.ailearn.auth.getState({ meta: createRequestMeta() });
      const session = unwrapGatewayResult(sessionResponse);
      if (session.status !== "authenticated" || !session.workspace) {
        if (generation === requestGenerationRef.current) {
          scopeRef.current = null;
          setState({ projection: null, loading: false, failure: "请先登录后再读取功能状态。" });
        }
        return;
      }

      const requestScope = {
        workspaceId: session.workspace.workspaceId,
        workspaceEpoch: session.workspaceEpoch,
      } satisfies ProjectionWorkspaceScope;
      if (generation !== requestGenerationRef.current) return;
      const previousScope = scopeRef.current;
      if (!sameProjectionScope(previousScope, requestScope)) {
        scopeRef.current = requestScope;
        setState((current) => beginProjectionRefresh(current, previousScope, requestScope));
      } else {
        scopeRef.current = requestScope;
      }

      const response = await window.ailearn.capabilities.get({
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
  }, [invalidation.revision, invalidation.workspaceEpoch, revision, surface]);

  const boundaryMismatch = Boolean(
    scopeRef.current
    && invalidation.workspaceEpoch !== null
    && invalidation.workspaceEpoch !== scopeRef.current.workspaceEpoch,
  );
  const value = useMemo(() => ({
    ...state,
    ...(boundaryMismatch ? { projection: null, loading: true, failure: null } : {}),
    reload,
  }), [boundaryMismatch, reload, state]);

  return (
    <HomeCapabilityProjectionContext.Provider value={value}>
      {children}
    </HomeCapabilityProjectionContext.Provider>
  );
}

export const useHomeCapabilityProjection = () => useContext(HomeCapabilityProjectionContext);

