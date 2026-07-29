/**
 * Milkdown destroys its editor context asynchronously during route changes.
 * A React ref can briefly outlive that context, so every imperative action
 * must verify the editor is still ready and tolerate teardown races.
 */
export function withReadyMilkdownEditor<TEditor extends { readonly status: string }, TResult>(
  editor: TEditor | undefined,
  operation: (readyEditor: TEditor) => TResult,
  fallback: TResult,
): TResult {
  if (!editor || editor.status !== "Created") return fallback;

  try {
    return operation(editor);
  } catch {
    return fallback;
  }
}
