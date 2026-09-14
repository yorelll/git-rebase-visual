export interface ActiveTextEditorLike {
  document: unknown;
}

export interface TextEditorSelectionLike {
  textEditor?: ActiveTextEditorLike;
}

/**
 * Inspector WebviewPanel focus may clear VS Code's activeTextEditor without the
 * user interacting with another text editor. Only a concrete TextEditor proves
 * a genuine external editor interaction that should dismiss the inspector.
 */
export function shouldDismissInspectorForActiveTextEditor(
  editor: ActiveTextEditorLike | undefined
): boolean {
  return !!editor;
}

/** A selection event always names its source TextEditor when it is external. */
export function shouldDismissInspectorForTextEditorSelection(
  event: TextEditorSelectionLike | undefined
): boolean {
  return !!event?.textEditor;
}
