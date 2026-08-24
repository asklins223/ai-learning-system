/**
 * Plan 23 FE-03：ObjectiveSourceLine —— 真实 Note/Source/version/freshness；
 * 不显示兜底“来源笔记”（§36/§13.3）。
 */
import type { JSX } from "react";
import { Icon } from "@/components/ui/icons";

export function ObjectiveSourceLine(props: {
  noteTitle: string | null;
  freshness: "fresh" | "source_outdated" | "legacy_unreviewed";
  noteVersionId?: string | null;
  onClickNote?: () => void;
  className?: string;
}): JSX.Element {
  const freshnessLabel =
    props.freshness === "source_outdated"
      ? "来源待更新"
      : props.freshness === "legacy_unreviewed"
        ? "来源未核验"
        : "来源已核验";
  return (
    <button
      type="button"
      className={"objective-source-line" + (props.className ? " " + props.className : "")}
      onClick={props.onClickNote}
      aria-label={props.noteTitle ? "来源笔记：" + props.noteTitle : freshnessLabel}
      disabled={!props.onClickNote}
    >
      <Icon.Folder aria-hidden="true" />
      {props.noteTitle ? (
        <span className="objective-source-line-note">{props.noteTitle}</span>
      ) : (
        <span className="objective-source-line-freshness">{freshnessLabel}</span>
      )}
    </button>
  );
}
