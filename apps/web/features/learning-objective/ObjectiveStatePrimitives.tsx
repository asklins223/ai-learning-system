/**
 * Plan 23 FE-05：Surface loading/empty/error primitives（共用且可访问）。
 */
import type { JSX } from "react";

export function ObjectiveSkeleton(props: { rows?: number; className?: string }): JSX.Element {
  const rows = props.rows ?? 3;
  return (
    <div className={props.className} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="objective-skeleton" style={{ blockSize: 72, marginBlockEnd: 12 }} />
      ))}
    </div>
  );
}

export function ObjectiveEmpty(props: { message: string; hint?: string }): JSX.Element {
  return (
    <div className="objective-empty" role="status">
      <p>{props.message}</p>
      {props.hint ? <p className="objective-muted">{props.hint}</p> : null}
    </div>
  );
}

export function ObjectiveError(props: {
  message: string;
  retryable?: boolean;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="objective-error" role="alert">
      <p>{props.message}</p>
      {props.retryable && props.onRetry ? (
        <button type="button" className="objective-secondary-action" onClick={props.onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}
