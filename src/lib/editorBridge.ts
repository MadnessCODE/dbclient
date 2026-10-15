// Lets panels outside the editor (Favorites) edit the active SQL editor.
import type * as MonacoApi from "monaco-editor";

type MonacoEditor = MonacoApi.editor.IStandaloneCodeEditor;

let current: { editor: MonacoEditor; tabId: () => string } | null = null;

export function setActiveEditor(editor: MonacoEditor | null, tabId?: () => string) {
  current = editor && tabId ? { editor, tabId } : null;
}

/** Inserts at the cursor (replacing a selection) as an undoable edit; false if no editor shows `tabId`. */
export function insertIntoEditor(tabId: string, text: string): boolean {
  if (!current || current.tabId() !== tabId) return false;
  const { editor } = current;
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return false;
  // keep statements apart when the editor has other SQL
  let insert = model.getValue().trim() && !/;\s*$/.test(text) ? `${text.trimEnd()};` : text;
  if (sel.isEmpty()) {
    const before = model.getLineContent(sel.startLineNumber).slice(0, sel.startColumn - 1);
    if (before.trim()) insert = `\n${insert}`;
  }
  editor.pushUndoStop();
  editor.executeEdits("favorite", [{ range: sel, text: insert, forceMoveMarkers: true }]);
  editor.pushUndoStop();
  editor.focus();
  return true;
}
