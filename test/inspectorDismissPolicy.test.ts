import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldDismissInspectorForActiveTextEditor,
  shouldDismissInspectorForTextEditorSelection,
} from "../src/ui/inspectorDismissPolicy";

test("inspector focus does not self-dismiss while genuine external TextEditor interaction does", () => {
  // VS Code WebviewPanel focus can change activeTextEditor to undefined. It is
  // not evidence that the user clicked a normal editor, so keep action buttons.
  assert.equal(shouldDismissInspectorForActiveTextEditor(undefined), false);
  assert.equal(shouldDismissInspectorForTextEditorSelection(undefined), false);
  assert.equal(shouldDismissInspectorForTextEditorSelection({}), false);

  const editor = { document: {} };
  assert.equal(shouldDismissInspectorForActiveTextEditor(editor), true, "normal right-side text editor click closes inspector");
  assert.equal(shouldDismissInspectorForTextEditorSelection({ textEditor: editor }), true, "selection in normal text editor closes inspector");
});
