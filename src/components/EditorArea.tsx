import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { format as formatSql } from "sql-formatter";
import {
  ArrowRightToLine,
  ChevronDown,
  ClipboardCopy,
  Copy,
  CopyX,
  SquareX,
  Unplug,
  Ellipsis,
  FileCode,
  ListTree,
  Play,
  Plus,
  Save,
  SaveAll,
  Square,
  TriangleAlert,
  WandSparkles,
  X,
} from "lucide-react";
import type * as MonacoApi from "monaco-editor";
import { monaco, setCompletionContext } from "../lib/monaco";
import { api, errorText, kindLabel } from "../lib/api";
import { statementAt } from "../lib/sql";
import { useActiveTab, useStore, type EditorTab, type MenuEntry } from "../store";
import { Button, cx, DbIcon, EnvBadge, IconButton, Spinner, StatusDot, MOD } from "./ui";
import { connColor, isProduction, tint } from "../lib/connStyle";

type MonacoEditor = MonacoApi.editor.IStandaloneCodeEditor;

// Autocomplete follows the active tab's schema.
setCompletionContext(() => {
  const s = useStore.getState();
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (!tab?.connId) return {};
  return { schema: s.conn[tab.connId]?.schema, kind: s.connections.find((c) => c.id === tab.connId)?.kind };
});

export function EditorArea() {
  const tabs = useStore((s) => s.tabs);
  const tab = useActiveTab();
  const editorRef = useRef<MonacoEditor | null>(null);
  const cfg = useStore((s) => s.connections.find((c) => c.id === tab?.connId));
  const color = connColor(cfg);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabsBar tabs={tabs} />
      {tab ? (
        <div
          style={color ? { borderColor: tint(color, 0.7) } : undefined}
          className="mx-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line-strong bg-panel-2"
        >
          {isProduction(cfg) && (
            <div
              style={{ background: tint(color ?? "#ef4444", 0.18), color: color ?? "#ef4444" }}
              className="flex h-7 shrink-0 items-center gap-2 px-3 text-[12px] font-medium"
            >
              <TriangleAlert size={14} />
              PRODUCTION · {cfg!.name}
              <span className="font-normal opacity-80">— statements that change data ask for confirmation</span>
            </div>
          )}
          <Toolbar tab={tab} editorRef={editorRef} />
          <SqlEditor tab={tab} editorRef={editorRef} />
        </div>
      ) : (
        <NoTabs />
      )}
    </div>
  );
}

function NoTabs() {
  const newTab = useStore((s) => s.newTab);
  return (
    <div className="m-3 flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong text-muted">
      <FileCode size={34} className="opacity-60" />
      <p>No open queries</p>
      <Button variant="primary" onClick={() => newTab()}>
        <Plus size={16} /> New Query
      </Button>
      <p className="text-[11px]">Tip: double-click a table in the schema tree to open it.</p>
    </div>
  );
}


/** Closes tabs, asking first about unsaved files. */
async function closeTabs(ids: string[]) {
  const st = useStore.getState();
  const dirty = st.tabs.filter((t) => ids.includes(t.id) && t.dirty);
  if (dirty.length > 0) {
    const names = dirty.map((t) => `• ${t.title}`).join("\n");
    const ok = await ask(`These tabs have unsaved changes:\n\n${names}\n\nClose them anyway?`, {
      title: "Unsaved changes",
      kind: "warning",
      okLabel: "Close without saving",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
  }
  for (const id of ids) useStore.getState().closeTab(id);
}

/** Tab context menu. */
function tabMenu(tab: EditorTab, tabs: EditorTab[]): MenuEntry[] {
  const st = useStore.getState();
  const idx = tabs.findIndex((t) => t.id === tab.id);
  const others = tabs.filter((t) => t.id !== tab.id).map((t) => t.id);
  const right = tabs.slice(idx + 1).map((t) => t.id);
  const sameConn = tab.connId ? tabs.filter((t) => t.connId === tab.connId).map((t) => t.id) : [];
  const connName = st.connections.find((c) => c.id === tab.connId)?.name;
  return [
    { label: "Close", icon: <X />, hint: `${MOD}+W`, onClick: () => void closeTabs([tab.id]) },
    { label: "Close others", icon: <CopyX />, disabled: others.length === 0, onClick: () => void closeTabs(others) },
    { label: "Close tabs to the right", icon: <ArrowRightToLine />, disabled: right.length === 0, onClick: () => void closeTabs(right) },
    { label: "Close all", icon: <SquareX />, onClick: () => void closeTabs(tabs.map((t) => t.id)) },
    ...(connName && sameConn.length > 1
      ? [{ label: `Close all "${connName}" tabs`, icon: <Unplug />, onClick: () => void closeTabs(sameConn) } as MenuEntry]
      : []),
    "sep",
    { label: "Duplicate tab", icon: <Copy />, onClick: () => st.newTab({ sql: tab.sql, connId: tab.connId, title: `${tab.title} (copy)`, table: tab.table }) },
    { label: "Copy SQL", icon: <ClipboardCopy />, disabled: !tab.sql.trim(), onClick: () => void navigator.clipboard.writeText(tab.sql) },
  ];
}

function TabsBar({ tabs }: { tabs: EditorTab[] }) {
  const activeTabId = useStore((s) => s.activeTabId);
  const connections = useStore((s) => s.connections);
  const runtime = useStore((s) => s.runtime);
  const { setActiveTab, closeTab, newTab } = useStore.getState();

  return (
    <div className="flex h-12 shrink-0 items-end gap-1 overflow-x-auto px-3 pt-2">
      {tabs.map((t) => {
        const tcfg = connections.find((c) => c.id === t.connId);
        const kind = tcfg?.kind;
        const tcolor = connColor(tcfg);
        const active = t.id === activeTabId;
        return (
          <div
            key={t.id}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(t.id);
              } else setActiveTab(t.id);
            }}
            onContextMenu={(e) => useStore.getState().openContextMenu(e, tabMenu(t, tabs))}
            style={tcolor ? { boxShadow: `inset 0 2px 0 ${tcolor}`, ...(active ? {} : { background: tint(tcolor, 0.08) }) } : undefined}
            title={tcfg ? `${tcfg.name}${tcfg.environment ? ` (${tcfg.environment})` : ""}` : undefined}
            className={cx(
              "group relative flex h-10 max-w-[220px] min-w-[150px] cursor-pointer items-center gap-2.5 rounded-t-lg border border-b-0 px-3",
              active ? "border-line-strong bg-panel-2 text-fg" : "border-transparent text-fg-2 hover:bg-hover",
            )}
          >
            {runtime[t.id]?.running ? <Spinner size={15} /> : kind ? <DbIcon kind={kind} size={16} /> : <FileCode size={16} className="text-muted" />}
            <span className="flex-1 truncate text-[13px]">{t.title}</span>
            {t.dirty && <span className="h-1.5 w-1.5 rounded-full bg-ok" title="Unsaved changes" />}
            {runtime[t.id]?.unseen && (
              <span
                className={cx("h-2 w-2 shrink-0 rounded-full", runtime[t.id]!.unseen === "ok" ? "bg-ok" : "bg-err")}
                title={runtime[t.id]!.unseen === "ok" ? "Query finished" : "Query failed"}
              />
            )}
            {runtime[t.id]?.running && <span className="loading-bar absolute inset-x-2 bottom-0 h-0.5 rounded-full" />}
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => closeTab(t.id)}
              className={cx("rounded p-0.5 text-muted hover:bg-hover hover:text-fg", !active && "opacity-0 group-hover:opacity-100")}
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      <IconButton title={`New query (${MOD}+T)`} className="mb-1.5" onClick={() => newTab()}>
        <Plus size={18} />
      </IconButton>
    </div>
  );
}


/** SQL to run: the selection, the statement under the cursor ("statement"), or everything. */
function sqlToRun(editor: MonacoEditor | null, mode: "selection-or-all" | "statement", tab: EditorTab): string {
  const kind = useStore.getState().connections.find((c) => c.id === tab.connId)?.kind ?? "postgres";
  const model = editor?.getModel();
  if (!editor || !model) return tab.sql;
  const sel = editor.getSelection();
  if (sel && !sel.isEmpty()) return model.getValueInRange(sel);
  if (mode === "statement") {
    const pos = editor.getPosition();
    const offset = pos ? model.getOffsetAt(pos) : 0;
    const st = statementAt(model.getValue(), offset, kind);
    if (st) {
      // briefly highlight what ran
      const a = model.getPositionAt(st.start);
      const b = model.getPositionAt(st.end);
      const ids = editor.createDecorationsCollection([
        { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), options: { className: "bg-accent-soft", isWholeLine: false } },
      ]);
      setTimeout(() => ids.clear(), 600);
      return st.text;
    }
  }
  return model.getValue();
}

async function saveTab(tab: EditorTab, saveAs = false) {
  let path = tab.filePath;
  if (!path || saveAs) {
    const picked = await save({ defaultPath: tab.title.endsWith(".sql") ? tab.title : `${tab.title}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (!picked) return;
    path = picked;
  }
  try {
    await api.writeTextFile(path, tab.sql);
    useStore.getState().updateTab(tab.id, { filePath: path, title: path.split(/[\\/]/).pop()!, dirty: false });
  } catch (e) {
    alert(errorText(e));
  }
}

function formatEditor(editor: MonacoEditor | null, tab: EditorTab) {
  const model = editor?.getModel();
  if (!editor || !model) return;
  const kind = useStore.getState().connections.find((c) => c.id === tab.connId)?.kind;
  const sel = editor.getSelection();
  const range = sel && !sel.isEmpty() ? sel : model.getFullModelRange();
  try {
    const formatted = formatSql(model.getValueInRange(range), {
      language: kind === "mysql" ? "mysql" : "postgresql",
      keywordCase: "upper",
      tabWidth: 4,
    });
    editor.executeEdits("format", [{ range, text: formatted }]);
    editor.pushUndoStop();
  } catch (e) {
    useStore.getState().patchRuntime(tab.id, { resultTab: "messages" });
    alert(`Format failed: ${errorText(e)}`);
  }
}

function Toolbar({ tab, editorRef }: { tab: EditorTab; editorRef: React.RefObject<MonacoEditor | null> }) {
  const rt = useStore((s) => s.runtime[tab.id]);
  const { runTab, cancelTab, explainTab } = useStore.getState();
  const [runMenu, setRunMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);

  const run = (mode: "selection-or-all" | "statement") => void runTab(tab.id, sqlToRun(editorRef.current, mode, tab));

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-3">
      <ConnectionPicker tab={tab} />

      {rt?.running ? (
        <Button variant="danger" onClick={() => void cancelTab(tab.id)} className="h-9 w-[108px]">
          <Square size={13} fill="currentColor" /> Cancel
        </Button>
      ) : (
        <div className="relative flex h-9">
          <button
            onClick={() => run("selection-or-all")}
            title="Run (selection or everything)"
            className="flex items-center gap-2 rounded-l-md bg-accent px-4 text-[13px] font-medium text-white hover:bg-accent-hover"
          >
            <Play size={15} /> Run
          </button>
          <button
            onClick={() => setRunMenu((v) => !v)}
            className="flex items-center rounded-r-md border-l border-white/20 bg-accent px-2 text-white hover:bg-accent-hover"
          >
            <ChevronDown size={15} />
          </button>
          {runMenu && (
            <Menu onClose={() => setRunMenu(false)}>
              <MenuItem label="Run current statement" shortcut={`${MOD}+Enter`} onClick={() => run("statement")} />
              <MenuItem label="Run all" shortcut={`${MOD}+Shift+Enter`} onClick={() => void runTab(tab.id)} />
            </Menu>
          )}
        </div>
      )}

      <Button className="h-9 px-4" onClick={() => void explainTab(tab.id, sqlToRun(editorRef.current, "statement", tab))} disabled={rt?.explaining}>
        {rt?.explaining ? <Spinner /> : <ListTree size={16} />} Explain
      </Button>
      <Button className="h-9 px-4" onClick={() => formatEditor(editorRef.current, tab)}>
        <WandSparkles size={16} /> Format
      </Button>

      <div className="relative ml-auto flex items-center gap-1">
        <IconButton title={`Save (${MOD}+S)`} onClick={() => void saveTab(tab)}>
          <Save size={17} />
        </IconButton>
        <IconButton title="Save as..." onClick={() => void saveTab(tab, true)}>
          <SaveAll size={17} />
        </IconButton>
        <IconButton title="More" onClick={() => setMoreMenu((v) => !v)}>
          <Ellipsis size={17} />
        </IconButton>
        {moreMenu && (
          <Menu onClose={() => setMoreMenu(false)} right>
            <MenuItem label="Duplicate tab" onClick={() => useStore.getState().newTab({ sql: tab.sql, connId: tab.connId, title: `${tab.title} (copy)` })} />
            <MenuItem label="Close other tabs" onClick={() => useStore.getState().tabs.filter((t) => t.id !== tab.id).forEach((t) => useStore.getState().closeTab(t.id))} />
            <MenuItem label="Close all tabs" onClick={() => [...useStore.getState().tabs].forEach((t) => useStore.getState().closeTab(t.id))} />
          </Menu>
        )}
      </div>
    </div>
  );
}

function ConnectionPicker({ tab }: { tab: EditorTab }) {
  const connections = useStore((s) => s.connections);
  const conn = useStore((s) => s.conn);
  const cfg = connections.find((c) => c.id === tab.connId);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        style={connColor(cfg) ? { borderColor: connColor(cfg)!, background: tint(connColor(cfg)!, 0.1) } : undefined}
        className="flex h-9 w-[260px] items-center gap-2 rounded-md border border-line-strong bg-panel px-2.5 text-left text-[13px] hover:border-accent/60"
      >
        {cfg ? (
          <>
            <DbIcon kind={cfg.kind} size={16} />
            <StatusDot status={conn[cfg.id]?.status} className="h-2 w-2" />
            <span className="flex-1 truncate">
              {cfg.name} <span className="text-muted">({kindLabel(cfg.kind)})</span>
            </span>
            <EnvBadge cfg={cfg} />
          </>
        ) : (
          <span className="flex-1 text-muted">Select connection…</span>
        )}
        <ChevronDown size={15} className="text-muted" />
      </button>
      {open && (
        <Menu onClose={() => setOpen(false)} width={260}>
          {connections.length === 0 && <div className="px-3 py-2 text-[12px] text-muted">No connections</div>}
          {connections.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                useStore.getState().updateTab(tab.id, { connId: c.id });
                useStore.getState().selectConnection(c.id);
                if (conn[c.id]?.status !== "connected") void useStore.getState().connectTo(c.id);
                setOpen(false);
              }}
              className={cx("flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-hover", c.id === tab.connId && "bg-accent-soft")}
            >
              <DbIcon kind={c.kind} size={15} />
              <StatusDot status={conn[c.id]?.status} className="h-2 w-2" />
              <span className="truncate">{c.name}</span>
              <span className="ml-auto text-[11px] text-muted">{kindLabel(c.kind)}</span>
            </button>
          ))}
        </Menu>
      )}
    </div>
  );
}

export function Menu({ children, onClose, right, width = 230 }: { children: React.ReactNode; onClose: () => void; right?: boolean; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // ref.current is null once the menu is closed
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Deferred so the opening click doesn't close it. The timer must be cleared, otherwise a
    // re-run effect leaks a listener that closes later menus.
    const t = setTimeout(() => window.addEventListener("mousedown", onDown));
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      onClick={(e) => (e.target as HTMLElement).closest("button") && onClose()}
      style={{ width }}
      className={cx("absolute top-full z-40 mt-1 rounded-lg border border-line-strong bg-raised p-1 shadow-xl", right ? "right-0" : "left-0")}
    >
      {children}
    </div>
  );
}

export function MenuItem({ label, shortcut, onClick, disabled }: { label: string; shortcut?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={onClick} className="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-hover disabled:opacity-40">
      {label}
      {shortcut && <span className="text-[11px] text-muted">{shortcut}</span>}
    </button>
  );
}


function SqlEditor({ tab, editorRef }: { tab: EditorTab; editorRef: React.RefObject<MonacoEditor | null> }) {
  const theme = useStore((s) => s.theme);
  const fontSize = useStore((s) => s.settings.fontSize);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // SQL changed elsewhere (e.g. History "Restore"): push it as an undoable edit
  useEffect(() => {
    const model = editorRef.current?.getModel();
    // the editor may still hold the previous tab's model
    if (!model || !model.uri.toString().includes(tab.id) || model.getValue() === tab.sql) return;
    editorRef.current!.pushUndoStop();
    editorRef.current!.executeEdits("external", [{ range: model.getFullModelRange(), text: tab.sql }]);
    editorRef.current!.pushUndoStop();
  }, [tab.sql, tab.id, editorRef]);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    const K = monaco.KeyMod;
    const C = monaco.KeyCode;
    const st = () => useStore.getState();
    editor.addAction({ id: "run-statement", label: "Run current statement", keybindings: [K.CtrlCmd | C.Enter], run: (ed) => void st().runTab(tabRef.current.id, sqlToRun(ed as MonacoEditor, "statement", tabRef.current)) });
    editor.addAction({ id: "run-all", label: "Run all", keybindings: [K.CtrlCmd | K.Shift | C.Enter, C.F5], run: () => void st().runTab(tabRef.current.id) });
    editor.addAction({ id: "format-sql", label: "Format SQL", keybindings: [K.Shift | K.Alt | C.KeyF], run: (ed) => formatEditor(ed as MonacoEditor, tabRef.current) });
    editor.addAction({ id: "save-sql", label: "Save", keybindings: [K.CtrlCmd | C.KeyS], run: () => void saveTab(st().tabs.find((t) => t.id === tabRef.current.id)!) });
    editor.addAction({ id: "explain-sql", label: "Explain", keybindings: [K.CtrlCmd | C.KeyE], run: (ed) => void st().explainTab(tabRef.current.id, sqlToRun(ed as MonacoEditor, "statement", tabRef.current)) });
    editor.focus();
  };

  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-b-lg">
      <Editor
        path={tab.id}
        defaultValue={tab.sql}
        defaultLanguage="sql"
        theme={theme === "dark" ? "dbclient-dark" : "dbclient-light"}
        onMount={onMount}
        onChange={(v) => useStore.getState().updateTab(tabRef.current.id, { sql: v ?? "", dirty: !!tabRef.current.filePath })}
        loading={<Spinner />}
        options={{
          fontSize,
          fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
          fontLigatures: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          padding: { top: 10 },
          lineNumbersMinChars: 3,
          renderLineHighlight: "line",
          tabSize: 4,
          wordWrap: "off",
          suggest: { showWords: false },
          quickSuggestions: { other: true, strings: false, comments: false },
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}
