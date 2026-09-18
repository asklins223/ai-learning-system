export type ProjectionWorkspaceScope = {
  readonly workspaceId: string;
  readonly workspaceEpoch: number;
};

export type ProjectionReadState<T> = {
  readonly projection: T | null;
  readonly loading: boolean;
  readonly failure: string | null;
};

export function sameProjectionScope(
  left: ProjectionWorkspaceScope | null,
  right: ProjectionWorkspaceScope | null,
): boolean {
  return left !== null
    && right !== null
    && left.workspaceId === right.workspaceId
    && left.workspaceEpoch === right.workspaceEpoch;
}

/** A same-workspace refresh keeps the last trusted value; a boundary change never does. */
export function beginProjectionRefresh<T>(
  current: ProjectionReadState<T>,
  currentScope: ProjectionWorkspaceScope | null,
  nextScope?: ProjectionWorkspaceScope | null,
): ProjectionReadState<T> {
  const mayKeepCurrent = nextScope === undefined || sameProjectionScope(currentScope, nextScope);
  return {
    projection: mayKeepCurrent ? current.projection : null,
    loading: true,
    failure: null,
  };
}

/** Refresh failures are degraded reads, not cache eviction, inside one verified workspace. */
export function failProjectionRefresh<T>(
  current: ProjectionReadState<T>,
  message: string,
): ProjectionReadState<T> {
  return {
    projection: current.projection,
    loading: false,
    failure: message,
  };
}

export function projectionResponseIsCurrent(
  requestGeneration: number,
  activeGeneration: number,
  expectedScope: ProjectionWorkspaceScope,
  activeScope: ProjectionWorkspaceScope | null,
  responseWorkspaceEpoch?: number,
): boolean {
  return requestGeneration === activeGeneration
    && sameProjectionScope(expectedScope, activeScope)
    && (responseWorkspaceEpoch === undefined || responseWorkspaceEpoch === expectedScope.workspaceEpoch);
}
