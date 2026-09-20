import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw, RotateCw } from "lucide-react";
import { SurfaceDataState } from "./surfaces/surface-data";
import "./render-error-boundary.css";

/**
 * 渲染失败的兜底层（2026-09-20）。
 *
 * 应用此前没有任何 ErrorBoundary：一棵子树在渲染时抛错，React 会卸载整棵树，
 * 用户看到的是一次"点一下就黑屏"——没有原因、没有出路，只能重启应用，而真实
 * 现场（哪一页、哪一句）只留在控制台里。
 *
 * 现在有两级：
 * - **页面级**（TaskSurface）：坏掉的那一页换成这张纸，书房其余部分——返回键、
 *   目录栏、伴星、场景——继续可用，用户可以从这里重试或退回；
 * - **外壳级**（App 根节点）：门禁、场景或伴星本身崩了时的最后一道，保证最坏
 *   情况下也有一张能读、能重试、能重载的纸。
 *
 * 只兜**渲染期**错误（含同步 effect 抛错）。事件回调与异步回调里的失败不经过
 * React，需要各自处理——那些不是"黑屏"这一类问题。
 */
export type RenderErrorBoundaryProps = {
  /** 这块区域的名字，报错文案读作「<label>没能打开」。 */
  readonly label: string;
  readonly children: ReactNode;
  /** 外壳级形态：占满窗口居中，而不是套进页面的 `.content` 版心。 */
  readonly shell?: boolean;
};

type RenderFailure = { readonly message: string; readonly stack: string | null };
type RenderErrorBoundaryState = { readonly failure: RenderFailure | null };

function describeFailure(error: unknown): RenderFailure {
  if (error instanceof Error) {
    return { message: error.message.trim() || error.name, stack: error.stack ?? null };
  }
  return { message: String(error), stack: null };
}

export class RenderErrorBoundary extends Component<
  RenderErrorBoundaryProps,
  RenderErrorBoundaryState
> {
  state: RenderErrorBoundaryState = { failure: null };

  static getDerivedStateFromError(error: unknown): RenderErrorBoundaryState {
    return { failure: describeFailure(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // 完整现场留在控制台（React 自己也会打一条）；界面只给用户能读的那部分。
    console.error(`[render] ${this.props.label} 渲染失败`, error, info.componentStack);
  }

  /** 重挂载子树：页面自己的数据读取会跟着重来一次，瞬时故障就此消失。 */
  private readonly retry = () => this.setState({ failure: null });

  private readonly reload = () => window.location.reload();

  render(): ReactNode {
    const failure = this.state.failure;
    if (!failure) return this.props.children;
    return (
      <main
        className={this.props.shell
          ? "render-error-boundary render-error-boundary--shell"
          : "content render-error-boundary"}
      >
        <SurfaceDataState
          kind="error"
          message={`${this.props.label}没能打开`}
          detail="这一页在渲染时出错了；书房的其他部分仍然可用。可以先重试，重试无效就重新载入应用。"
          action={(
            <>
              <p className="render-error-boundary__reason">{failure.message}</p>
              {import.meta.env.DEV && failure.stack
                ? <details className="render-error-boundary__stack"><summary>调用位置</summary><pre>{failure.stack}</pre></details>
                : null}
              <div className="render-error-boundary__actions">
                <button type="button" className="button primary" onClick={this.retry}>
                  <RefreshCw size={15} aria-hidden="true" />重试
                </button>
                <button type="button" className="button" onClick={this.reload}>
                  <RotateCw size={15} aria-hidden="true" />重新载入应用
                </button>
              </div>
            </>
          )}
        />
      </main>
    );
  }
}
