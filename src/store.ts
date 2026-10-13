// App state (zustand). Tabs, history and settings persist between runs.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ask } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isProduction, writeStatements } from "./lib/connStyle";
import { splitStatements } from "./lib/sql";
import {
  api,
  errorText,
  type ConnectionConfig,
  type DatabaseInfo,
  type Project,
  type QueryOutput,
  type DbKind,
  type ResultSet,
  type SchemaTree,
  type ServerInfo,
} from "./lib/api";
import { baseId, dbOf, isMultiDb } from "./lib/connIds";

export type ConnStatus = "idle" | "connecting" | "connected" | "error";

export interface ConnState {
  status: ConnStatus;
  info?: ServerInfo;
  schema?: SchemaTree;
  schemaLoading?: boolean;
  error?: string;
  /** PostgreSQL without a default database: databases on the server */
  databases?: DatabaseInfo[];
}

export interface EditorTab {
  id: string;
  title: string;
  sql: string;
  connId: string | null;
  filePath?: string;
  dirty?: boolean;
  /** Table the tab belongs to (Structure tab), if known */
  table?: TableRef;
}

export interface TableRef {
  schema: string;
  table: string;
}

export interface Message {
  at: number;
  kind: "info" | "ok" | "error";
  text: string;
}

export type ResultTab = "results" | "structure" | "messages" | "history" | "explain";

export interface TabRuntime {
  running: boolean;
  queryId?: string;
  startedAt?: number;
  output?: QueryOutput;
  activeSet: number;
  error?: string;
  explain?: string;
  explaining?: boolean;
  messages: Message[];
  resultTab: ResultTab;
  /** Last executed SQL, to refresh results after saving edits */
  lastSql?: string;
  /** A long query finished while the tab was inactive */
  unseen?: "ok" | "error";
}

export interface HistoryItem {
  id: string;
  /** Tab the query ran in */
  tabId?: string;
  sql: string;
  connId: string | null;
  title: string;
  at: number;
  ms?: number;
  ok: boolean;
  /** "100 rows", "3 rows affected" or the error */
  summary?: string;
}

/** Queries at least this long mark the tab / send a system notification. */
const LONG_QUERY_MS = 5000;

/** System notification for a finished long query (asks permission once). */
async function notifyDone(title: string, ok: boolean, summary: string, ms: number) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    const secs = (ms / 1000).toFixed(1);
    sendNotification({
      title: ok ? `Query finished: ${title}` : `Query failed: ${title}`,
      body: ok ? `${summary} · ${secs} s` : summary.slice(0, 200),
    });
  } catch {
    // notifications unavailable (e.g. outside Tauri)
  }
}

/** History limit across all tabs. */
const HISTORY_LIMIT = 1000;

export interface Settings {
  maxRows: number;
  pageSize: number;
  fontSize: number;
}

type LeftPanel = "connections";

/** Context menu item; "sep" is a separator. */
export type MenuEntry =
  | "sep"
  | {
      label: string;
      icon?: React.ReactNode;
      onClick?: () => void;
      danger?: boolean;
      disabled?: boolean;
      hint?: string;
      /** Keyboard shortcut shown on the right */
      shortcut?: string;
      children?: MenuEntry[];
    };

/** Dialog that runs SQL (drop, rename, truncate...), optionally with a name input. */
export interface ActionDialog {
  title: string;
  connId: string;
  message?: string;
  danger?: boolean;
  confirmLabel: string;
  input?: { label: string; value: string };
  /** Text that must be typed to enable the button (DROP DATABASE) */
  requireInput?: string;
  /** SQL from the typed name */
  buildSql: (input: string) => string;
  /** e.g. close our own connections to a database before dropping it */
  beforeRun?: () => Promise<void>;
  afterRun?: () => void;
}

interface PasswordPrompt {
  connId: string;
  error?: string;
}

export interface ExportJob {
  rs: ResultSet;
  /** Base for the file name and INSERT INTO */
  name: string;
  kind: DbKind;
  /** Source tab (grid sort order and selection) */
  tabId?: string;
  /** Query and connection, so the wizard can re-run it without a limit */
  connId?: string | null;
  sql?: string;
}

export interface Secrets {
  password: string;
  sshSecret?: string;
}

interface State {
  connections: ConnectionConfig[];
  projects: Project[];
  conn: Record<string, ConnState>;
  selectedConnId: string | null;

  tabs: EditorTab[];
  activeTabId: string | null;
  runtime: Record<string, TabRuntime>;
  untitledCounter: number;

  history: HistoryItem[];
  theme: "dark" | "light";
  settings: Settings;

  leftPanel: LeftPanel;
  view: "home" | "workspace" | "processes";
  connDialog: { open: boolean; editing?: ConnectionConfig; projectId?: string | null };
  projectDialog: { open: boolean; editing?: Project };
  passwordPrompt: PasswordPrompt | null;
  paletteOpen: boolean;
  settingsOpen: boolean;
  aboutOpen: boolean;
  resultsMaximized: boolean;
  contextMenu: { x: number; y: number; items: MenuEntry[] } | null;
  actionDialog: ActionDialog | null;
  exportJob: ExportJob | null;
  /** Import wizard, with a suggested connection/database */
  importDialog: { connId?: string | null; database?: string | null } | null;
  /** Users & privileges dialog: connection, selected user ("new" = create), open the drop confirmation */
  usersDialog: { connId: string; user?: string; drop?: boolean } | null;
  /** ER diagram of a schema */
  erDialog: { connId: string; schema: string } | null;
  /** Bumped after user changes so the tree reloads */
  usersVersion: number;

  // connections
  loadConnections: () => Promise<void>;
  /** Error loading saved connections (shown instead of an empty list) */
  connectionsError: string | null;
  selectConnection: (id: string | null) => void;
  connectTo: (id: string, secrets?: Secrets) => Promise<boolean>;
  disconnectFrom: (id: string) => Promise<void>;
  refreshSchema: (id: string) => Promise<void>;
  loadDatabases: (id: string) => Promise<void>;
  removeConnection: (id: string) => Promise<void>;
  upsertConnection: (cfg: ConnectionConfig) => void;
  submitPassword: (secrets: Secrets | null) => void;

  // projects
  upsertProject: (p: Project) => void;
  removeProject: (id: string) => Promise<void>;
  moveConnections: (ids: string[], projectId: string | null) => Promise<void>;

  // tabs
  newTab: (opts?: {
    sql?: string;
    connId?: string | null;
    title?: string;
    run?: boolean;
    filePath?: string;
    table?: TableRef;
    resultTab?: ResultTab;
  }) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<EditorTab>) => void;
  runTab: (id: string, sql?: string) => Promise<void>;
  cancelTab: (id: string) => Promise<void>;
  explainTab: (id: string, sql: string) => Promise<void>;
  patchRuntime: (id: string, patch: Partial<TabRuntime>) => void;

  // misc
  clearHistory: (tabId?: string) => void;
  toggleTheme: () => void;
  setSettings: (patch: Partial<Settings>) => void;
  setUi: (
    patch: Partial<Pick<State, "leftPanel" | "view" | "connDialog" | "projectDialog" | "paletteOpen" | "settingsOpen" | "aboutOpen" | "resultsMaximized" | "contextMenu" | "actionDialog" | "exportJob" | "importDialog" | "usersDialog" | "usersVersion" | "erDialog">>,
  ) => void;
  openContextMenu: (e: React.MouseEvent, items: MenuEntry[]) => void;
}

const uid = () => crypto.randomUUID();

const emptyRuntime = (): TabRuntime => ({ running: false, activeSet: 0, messages: [], resultTab: "results" });

const DDL = /^\s*(create|alter|drop|rename|truncate|comment)\b/im;

// Resolver for the password prompt that connectTo waits on.
let passwordResolver: ((s: Secrets | null) => void) | null = null;

export const useStore = create<State>()(
  persist(
    (set, get) => {
      const setConn = (id: string, patch: Partial<ConnState>) =>
        set((s) => ({ conn: { ...s.conn, [id]: { ...(s.conn[id] ?? { status: "idle" }), ...patch } } }));

      const runtimeOf = (id: string) => get().runtime[id] ?? emptyRuntime();

      const addMessage = (tabId: string, kind: Message["kind"], text: string) => {
        const rt = runtimeOf(tabId);
        get().patchRuntime(tabId, { messages: [...rt.messages, { at: Date.now(), kind, text }].slice(-200) });
      };

      const askPassword = (connId: string, error?: string) =>
        new Promise<Secrets | null>((resolve) => {
          passwordResolver = resolve;
          set({ passwordPrompt: { connId, error } });
        });

      return {
        connections: [],
        projects: [],
        conn: {},
        selectedConnId: null,
        tabs: [],
        activeTabId: null,
        runtime: {},
        untitledCounter: 0,
        history: [],
        theme: "dark",
        settings: { maxRows: 10000, pageSize: 50, fontSize: 14 },
        leftPanel: "connections",
        view: "home",
        connDialog: { open: false },
        projectDialog: { open: false },
        passwordPrompt: null,
        paletteOpen: false,
        settingsOpen: false,
        aboutOpen: false,
        resultsMaximized: false,
        contextMenu: null,
        actionDialog: null,
        exportJob: null,
        importDialog: null,
        usersDialog: null,
        erDialog: null,
        usersVersion: 0,

        connectionsError: null,

        loadConnections: async () => {
          let connections: ConnectionConfig[];
          try {
            connections = await api.listConnections();
          } catch (e) {
            set({ connectionsError: errorText(e) });
            throw e;
          }
          // a failure loading projects must not hide connections
          let projects: Project[] = [];
          try {
            projects = await api.listProjects();
          } catch (e) {
            console.error("listProjects", e);
          }
          set({ connections, projects, connectionsError: null });
          const sel = get().selectedConnId;
          if (sel && !connections.some((c) => c.id === sel)) set({ selectedConnId: null });
        },

        selectConnection: (id) => set({ selectedConnId: id }),

        connectTo: async (id, secrets) => {
          const cfg = get().connections.find((c) => c.id === baseId(id));
          if (!cfg) return false;
          const db = dbOf(id);
          if (db) {
            // another database on the same server: reuse the server connection
            if (get().conn[cfg.id]?.status !== "connected" && !(await get().connectTo(cfg.id, secrets))) return false;
            setConn(id, { status: "connecting", error: undefined });
            try {
              const info = await api.openDatabase(cfg.id, db);
              setConn(id, { status: "connected", info });
              void get().refreshSchema(id);
              return true;
            } catch (e) {
              setConn(id, { status: "error", error: errorText(e) });
              return false;
            }
          }
          let sec = secrets;
          if (sec === undefined && !cfg.savePassword) {
            const entered = await askPassword(id);
            if (entered === null) return false;
            sec = entered;
          }
          setConn(id, { status: "connecting", error: undefined });
          try {
            const info = await api.connect(id, sec?.password, sec?.sshSecret);
            setConn(id, { status: "connected", info });
            void get().refreshSchema(id);
            if (isMultiDb(cfg)) void get().loadDatabases(id);
            return true;
          } catch (e) {
            const error = errorText(e);
            setConn(id, { status: "error", error });
            // wrong password: ask again
            if (/password|authentication|access denied/i.test(error)) {
              const again = await askPassword(id, error);
              if (again !== null) return get().connectTo(id, again);
            }
            return false;
          }
        },

        disconnectFrom: async (id) => {
          await api.disconnect(id);
          // closing the server connection closes its databases too
          const ids = Object.keys(get().conn).filter((k) => k === id || (!dbOf(id) && baseId(k) === id));
          for (const k of ids) setConn(k, { status: "idle", schema: undefined, info: get().conn[k]?.info });
        },

        loadDatabases: async (id) => {
          try {
            setConn(id, { databases: await api.listDatabases(id) });
          } catch (e) {
            setConn(id, { error: errorText(e) });
          }
        },

        refreshSchema: async (id) => {
          setConn(id, { schemaLoading: true });
          try {
            const schema = await api.getSchema(id);
            setConn(id, { schema, schemaLoading: false });
          } catch (e) {
            setConn(id, { schemaLoading: false, error: errorText(e) });
          }
        },

        removeConnection: async (id) => {
          await api.deleteConnection(id);
          set((s) => {
            const conn = { ...s.conn };
            delete conn[id];
            return {
              connections: s.connections.filter((c) => c.id !== id),
              conn,
              selectedConnId: s.selectedConnId === id ? null : s.selectedConnId,
              tabs: s.tabs.map((t) => (baseId(t.connId) === id ? { ...t, connId: null } : t)),
            };
          });
        },

        upsertConnection: (cfg) =>
          set((s) => ({
            connections: s.connections.some((c) => c.id === cfg.id)
              ? s.connections.map((c) => (c.id === cfg.id ? cfg : c))
              : [...s.connections, cfg],
          })),

        upsertProject: (p) =>
          set((s) => ({ projects: s.projects.some((x) => x.id === p.id) ? s.projects.map((x) => (x.id === p.id ? p : x)) : [...s.projects, p] })),

        removeProject: async (id) => {
          await api.deleteProject(id);
          set((s) => ({
            projects: s.projects.filter((p) => p.id !== id),
            connections: s.connections.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)),
          }));
        },

        moveConnections: async (ids, projectId) => {
          const changed = await api.moveConnections(ids, projectId);
          set((s) => ({ connections: s.connections.map((c) => changed.find((x) => x.id === c.id) ?? c) }));
        },

        submitPassword: (secrets) => {
          set({ passwordPrompt: null });
          passwordResolver?.(secrets);
          passwordResolver = null;
        },

        newTab: (opts = {}) => {
          const id = uid();
          const n = get().untitledCounter + 1;
          const tab: EditorTab = {
            id,
            title: opts.title ?? `Untitled ${n}`,
            sql: opts.sql ?? "",
            connId: opts.connId !== undefined ? opts.connId : get().selectedConnId,
            filePath: opts.filePath,
            table: opts.table,
          };
          set((s) => ({
            view: "workspace",
            tabs: [...s.tabs, tab],
            activeTabId: id,
            untitledCounter: opts.title ? s.untitledCounter : n,
          }));
          if (opts.resultTab) get().patchRuntime(id, { resultTab: opts.resultTab });
          if (opts.run) void get().runTab(id);
          return id;
        },

        closeTab: (id) =>
          set((s) => {
            const idx = s.tabs.findIndex((t) => t.id === id);
            const tabs = s.tabs.filter((t) => t.id !== id);
            const runtime = { ...s.runtime };
            delete runtime[id];
            let activeTabId = s.activeTabId;
            if (activeTabId === id) activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
            return { tabs, runtime, activeTabId };
          }),

        setActiveTab: (id) => {
          const tab = get().tabs.find((t) => t.id === id);
          set({ view: "workspace", activeTabId: id, ...(tab?.connId ? { selectedConnId: tab.connId } : {}) });
          if (get().runtime[id]?.unseen) get().patchRuntime(id, { unseen: undefined });
        },

        updateTab: (id, patch) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

        patchRuntime: (id, patch) =>
          set((s) => ({ runtime: { ...s.runtime, [id]: { ...(s.runtime[id] ?? emptyRuntime()), ...patch } } })),

        runTab: async (tabId, sqlArg) => {
          const tab = get().tabs.find((t) => t.id === tabId);
          if (!tab) return;
          const sql = (sqlArg ?? tab.sql).trim();
          if (!sql) return;
          if (!tab.connId) {
            addMessage(tabId, "error", "Select a connection for this tab first.");
            get().patchRuntime(tabId, { resultTab: "messages" });
            return;
          }
          const connId = tab.connId;
          if (get().conn[connId]?.status !== "connected") {
            const ok = await get().connectTo(connId);
            if (!ok) {
              addMessage(tabId, "error", get().conn[connId]?.error ?? "Could not connect.");
              get().patchRuntime(tabId, { resultTab: "messages" });
              return;
            }
          }

          // production: confirm statements that change data or structure
          const cfg = get().connections.find((c) => c.id === baseId(connId));
          if (isProduction(cfg)) {
            const writes = writeStatements(splitStatements(sql, cfg!.kind).map((st) => st.text));
            if (writes.length > 0) {
              const preview = writes
                .slice(0, 3)
                .map((w) => (w.length > 140 ? `${w.slice(0, 140)}…` : w))
                .join("\n\n");
              const more = writes.length > 3 ? `\n\n…and ${writes.length - 3} more` : "";
              const ok = await ask(
                `You are about to change data on PRODUCTION (${cfg!.name}):\n\n${preview}${more}\n\nRun ${writes.length} statement${writes.length > 1 ? "s" : ""}?`,
                { title: "Production database", kind: "warning", okLabel: "Run on production", cancelLabel: "Cancel" },
              );
              if (!ok) {
                addMessage(tabId, "info", "Cancelled: not run on production.");
                return;
              }
            }
          }

          const queryId = uid();
          get().patchRuntime(tabId, { running: true, queryId, startedAt: Date.now(), error: undefined, lastSql: sql });
          const historyItem: HistoryItem = { id: queryId, tabId, sql, connId, title: tab.title, at: Date.now(), ok: false };
          try {
            const output = await api.runQuery(connId, queryId, sql, get().settings.maxRows);
            const sets = output.resultSets;
            let lastRows = -1;
            sets.forEach((rs, i) => {
              if (rs.returnsRows) lastRows = i;
            });
            get().patchRuntime(tabId, {
              running: false,
              output,
              activeSet: Math.max(lastRows, 0),
              resultTab: runtimeOf(tabId).resultTab === "structure" && lastRows >= 0 ? "structure" : lastRows >= 0 ? "results" : "messages",
            });
            const ms = Math.round(output.elapsedMs);
            if (sets.length === 0) addMessage(tabId, "ok", `Query executed in ${ms} ms`);
            for (const rs of sets) {
              addMessage(
                tabId,
                "ok",
                rs.returnsRows
                  ? `${rs.rows.length.toLocaleString()} rows returned${rs.truncated ? " (limit reached)" : ""} in ${ms} ms`
                  : `${rs.rowsAffected.toLocaleString()} rows affected in ${ms} ms`,
              );
            }
            historyItem.ok = true;
            historyItem.ms = ms;
            historyItem.summary =
              sets
                .map((rs) => (rs.returnsRows ? `${rs.rows.length.toLocaleString()} rows${rs.truncated ? "+" : ""}` : `${rs.rowsAffected.toLocaleString()} affected`))
                .join(" · ") || "done";
            if (DDL.test(sql)) void get().refreshSchema(connId);
          } catch (e) {
            const error = errorText(e);
            historyItem.summary = error;
            get().patchRuntime(tabId, { running: false, error, resultTab: "messages" });
            addMessage(tabId, "error", error);
          }
          set((s) => ({ history: [historyItem, ...s.history].slice(0, HISTORY_LIMIT) }));

          // long query (5 s+): mark an inactive tab and notify if the window is in the background
          const took = Date.now() - historyItem.at;
          if (took >= LONG_QUERY_MS) {
            const status = historyItem.ok ? "ok" : "error";
            if (get().activeTabId !== tabId) get().patchRuntime(tabId, { unseen: status });
            if (!document.hasFocus()) void notifyDone(tab.title, historyItem.ok, historyItem.summary ?? "", took);
          }
        },

        cancelTab: async (tabId) => {
          const qid = runtimeOf(tabId).queryId;
          if (!qid) return;
          try {
            await api.cancelQuery(qid);
            addMessage(tabId, "info", "Cancel requested.");
          } catch (e) {
            addMessage(tabId, "error", errorText(e));
          }
        },

        explainTab: async (tabId, sql) => {
          const tab = get().tabs.find((t) => t.id === tabId);
          if (!tab?.connId || !sql.trim()) return;
          if (get().conn[tab.connId]?.status !== "connected" && !(await get().connectTo(tab.connId))) return;
          get().patchRuntime(tabId, { explaining: true, resultTab: "explain" });
          try {
            const explain = await api.explainQuery(tab.connId, sql);
            get().patchRuntime(tabId, { explain, explaining: false });
          } catch (e) {
            get().patchRuntime(tabId, { explain: undefined, explaining: false, resultTab: "messages" });
            addMessage(tabId, "error", errorText(e));
          }
        },

        clearHistory: (tabId) => set((s) => ({ history: tabId ? s.history.filter((h) => h.tabId !== tabId) : [] })),
        toggleTheme: () => set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
        setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
        setUi: (patch) => set(patch),
        openContextMenu: (e, items) => {
          e.preventDefault();
          e.stopPropagation();
          set({ contextMenu: { x: e.clientX, y: e.clientY, items } });
        },
      };
    },
    {
      name: "dbclient-state",
      version: 1,
      partialize: (s) => ({
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        untitledCounter: s.untitledCounter,
        history: s.history,
        theme: s.theme,
        settings: s.settings,
        selectedConnId: s.selectedConnId,
      }),
    },
  ),
);

export const useActiveTab = () => useStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);

export const useConnection = (id: string | null | undefined) =>
  useStore((s) => (id ? s.connections.find((c) => c.id === baseId(id)) : undefined));
