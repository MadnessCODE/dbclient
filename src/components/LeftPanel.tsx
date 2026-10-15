import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ChevronDown,
  ChevronsUpDown,
  Crosshair,
  ChevronRight,
  Database,
  Ellipsis,
  FolderPlus,
  Import,
  Eye,
  Layers,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Sheet,
  SquareFunction,
  TableProperties,
  Trash2,
  Unplug,
  UserCog,
  UserPlus,
  UserRound,
  Users,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { errorText, type ConnectionConfig, type DatabaseInfo, type Project, type SchemaInfo, type TableStat } from "../lib/api";
import { accountKey, listAccounts, type Account } from "../lib/users";
import { ProjectIcon } from "./ProjectIcon";
import { useStore, type MenuEntry, type TreeFocus } from "../store";
import { categoryMenu, connectionMenu, databaseMenu, editorDb, editorName, routineMenu, schemaMenu, tableMenu, type ObjectKind } from "../lib/treeActions";
import { baseId, dbOf, isMultiDb, subId } from "../lib/connIds";
import { Button, cx, DbIcon, EnvBadge, IconButton, SchemaIcon, SearchInput, Spinner } from "./ui";
import { connColor, tint } from "../lib/connStyle";
import { ensureBadges, openDoctor, refKey, useDoctor } from "../lib/doctor";
import type { Finding } from "../lib/api";

export function LeftPanel({ width }: { width: number }) {
  return (
    <aside style={{ width }} className="flex shrink-0 flex-col overflow-hidden border-r border-line bg-panel">
      <ConnectionsTree />
    </aside>
  );
}


type Category = "tables" | "views" | "matViews" | "functions" | "procedures" | "triggers";

export const CATEGORIES: { key: Category; label: string; icon: LucideIcon; kind: ObjectKind }[] = [
  { key: "tables", label: "Tables", icon: Sheet, kind: "table" },
  { key: "views", label: "Views", icon: Eye, kind: "view" },
  { key: "matViews", label: "Materialized Views", icon: Layers, kind: "matview" },
  { key: "functions", label: "Functions", icon: SquareFunction, kind: "function" },
  { key: "procedures", label: "Procedures", icon: Workflow, kind: "procedure" },
  { key: "triggers", label: "Triggers", icon: Zap, kind: "trigger" },
];

/** Item count at which an expanded list gets its own filter. */
const SEARCH_FROM = 8;
/** Max items rendered at once; the rest are reachable by filtering. */
const MAX_ITEMS = 500;

const matches = (name: string, q: string) => !q || name.toLowerCase().includes(q.toLowerCase());

/** Drag data type for moving a connection into a project. */
const DRAG_TYPE = "application/x-dbclient-connection";

/** Collapsed state, remembered per project. */
function useCollapsed(key: string): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem(`collapsed:${key}`) === "1";
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    setV(next);
    try {
      localStorage.setItem(`collapsed:${key}`, next ? "1" : "0");
    } catch {
      // ignore
    }
  };
  return [v, set];
}

/** Drop target for a dragged connection; `onDrop` gets its id. */
function useDropTarget(onDrop: (connId: string) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      },
      onDrop: (e: React.DragEvent) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        setOver(false);
        if (id) {
          e.preventDefault();
          onDrop(id);
        }
      },
    },
  };
}

function ConnectionsTree() {
  const connections = useStore((s) => s.connections);
  const projects = useStore((s) => s.projects);
  const loadError = useStore((s) => s.connectionsError);
  const setUi = useStore((s) => s.setUi);
  const focus = useStore((s) => s.focus);
  const [filter, setFilter] = useState("");

  const sorted = useMemo(() => [...connections].sort((a, b) => a.name.localeCompare(b.name)), [connections]);
  const connMatches = (c: ConnectionConfig) => matches(c.name, filter) || matches(c.host, filter) || matches(c.ssh?.host ?? "", filter);

  const groups = useMemo(
    () =>
      [...projects]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => {
          const all = sorted.filter((c) => c.projectId === p.id);
          // a matching project name shows all its connections
          const items = !filter || matches(p.name, filter) ? all : all.filter(connMatches);
          return { project: p, items, total: all.length };
        })
        .filter((g) => !filter || g.items.length > 0 || matches(g.project.name, filter)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, sorted, filter],
  );
  const known = new Set(projects.map((p) => p.id));
  const loose = sorted.filter((c) => !c.projectId || !known.has(c.projectId)).filter((c) => !filter || connMatches(c));
  const nothingFound = connections.length > 0 && groups.length === 0 && loose.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 px-4 pt-4 pb-3">
        <h2 className="text-[15px] font-semibold">Connections</h2>
        <div className="flex gap-2">
          <Button variant="primary" className="flex-1" onClick={() => setUi({ connDialog: { open: true } })}>
            <Plus size={16} /> New Connection
          </Button>
          <Button title="New project (group of connections)" className="h-8 w-9 shrink-0 px-0" onClick={() => setUi({ projectDialog: { open: true } })}>
            <FolderPlus size={16} />
          </Button>
          <Button title="Import connections from DBeaver, pgAdmin, Workbench, Sequel Ace…" className="h-8 w-9 shrink-0 px-0" onClick={() => setUi({ connImport: true })}>
            <Import size={16} />
          </Button>
        </div>
        {!focus?.open && (connections.length > 3 || projects.length > 0) && (
          <SearchInput value={filter} onChange={setFilter} placeholder="Search connections & projects..." />
        )}
        {focus && !focus.open && focus.schema && (
          <button
            onClick={() => useStore.getState().setFocus({ ...focus, open: true })}
            className="flex w-full items-center gap-2 rounded-md border border-dashed border-line-strong px-2.5 py-1.5 text-left text-[12px] text-fg-2 hover:border-accent hover:text-fg"
            title="Back to the focused schema"
          >
            <Crosshair size={13} className="shrink-0 text-accent" />
            <span className="truncate">
              Back to <b className="font-medium text-fg">{focus.schema}</b>
            </span>
          </button>
        )}
      </div>
      {focus?.open ? (
        <FocusView focus={focus} />
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 text-[13px]">
        {loadError && (
          <div className="mx-2 my-2 rounded-md bg-err/10 px-3 py-2.5 text-[12px] text-err">
            <p className="selectable break-words">Could not load saved connections: {loadError}</p>
            <button className="mt-1.5 text-accent hover:underline" onClick={() => void useStore.getState().loadConnections().catch(() => {})}>
              Retry
            </button>
          </div>
        )}
        {!loadError && connections.length === 0 && projects.length === 0 && (
          <p className="px-3 py-4 text-center text-[12px] text-muted">
            No connections yet. Click “New Connection”, or{" "}
            <button className="text-accent hover:underline" onClick={() => setUi({ connImport: true })}>
              import them from DBeaver, pgAdmin, Workbench or Sequel Ace
            </button>
            .
          </p>
        )}
        {nothingFound && <Empty text="Nothing matches the search." />}
        {groups.map((g) => (
          <ProjectGroup key={g.project.id} project={g.project} items={g.items} total={g.total} forceOpen={!!filter} />
        ))}
        <LooseConnections items={loose} showHeader={projects.length > 0} />
      </div>
      )}
    </div>
  );
}

function ProjectGroup({ project, items, total, forceOpen }: { project: Project; items: ConnectionConfig[]; total: number; forceOpen: boolean }) {
  const [collapsed, setCollapsed] = useCollapsed(project.id);
  const open = forceOpen || !collapsed;
  const st = useStore.getState;
  const drop = useDropTarget((id) => void st().moveConnections([id], project.id));
  const color = connColor(project);

  const remove = async () => {
    if (await ask(`Delete project "${project.name}"? Its ${total} connection(s) are kept and moved out of the project.`, { title: "Delete project", kind: "warning" })) {
      await st().removeProject(project.id).catch((e) => alert(errorText(e)));
    }
  };

  const menu: MenuEntry[] = [
    { label: "New connection in project…", icon: <Plus />, onClick: () => st().setUi({ connDialog: { open: true, projectId: project.id } }) },
    { label: "Edit project…", icon: <Pencil />, onClick: () => st().setUi({ projectDialog: { open: true, editing: project } }) },
    "sep",
    { label: "Delete project…", icon: <Trash2 />, danger: true, onClick: () => void remove() },
  ];

  return (
    <div {...drop.props} className={cx("mb-1 rounded-lg", drop.over && "bg-accent-soft ring-1 ring-accent")}>
      <div
        onClick={() => setCollapsed(open)}
        onContextMenu={(e) => st().openContextMenu(e, menu)}
        className="group relative flex h-9 cursor-pointer items-center gap-2 rounded-md pr-2 pl-1 hover:bg-hover"
      >
        {open ? <ChevronDown size={14} className="shrink-0 text-muted" /> : <ChevronRight size={14} className="shrink-0 text-muted" />}
        <ProjectIcon project={project} size={22} />
        <span className="flex-1 truncate font-semibold text-fg">{project.name}</span>
        <span className="text-[11px] text-muted group-hover:invisible">{total}</span>
        {/* actions float over the row end so the row height stays fixed */}
        <div className="absolute top-1/2 right-1 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-hover group-hover:flex">
          <IconButton
            title="New connection in this project"
            onClick={(e) => {
              e.stopPropagation();
              st().setUi({ connDialog: { open: true, projectId: project.id } });
            }}
          >
            <Plus size={14} />
          </IconButton>
          <IconButton
            title="Edit project"
            onClick={(e) => {
              e.stopPropagation();
              st().setUi({ projectDialog: { open: true, editing: project } });
            }}
          >
            <Pencil size={14} />
          </IconButton>
        </div>
      </div>
      {open && (
        <div style={{ borderColor: color ? tint(color, 0.5) : undefined }} className="ml-3 border-l border-line-strong pl-1.5">
          {items.map((c) => (
            <ConnectionNode key={c.id} cfg={c} />
          ))}
          {total === 0 && <div className="px-2 py-1.5 text-[12px] text-muted">Drag connections here, or use + to add one.</div>}
        </div>
      )}
    </div>
  );
}

/** Connections without a project (also the drop target to leave one). */
function LooseConnections({ items, showHeader }: { items: ConnectionConfig[]; showHeader: boolean }) {
  const drop = useDropTarget((id) => void useStore.getState().moveConnections([id], null));
  if (!showHeader) {
    return (
      <>
        {items.map((c) => (
          <ConnectionNode key={c.id} cfg={c} />
        ))}
      </>
    );
  }
  return (
    <div {...drop.props} className={cx("mt-2 rounded-lg pb-1", drop.over && "bg-accent-soft ring-1 ring-accent")}>
      <div className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wider text-muted uppercase">No project</div>
      {items.map((c) => (
        <ConnectionNode key={c.id} cfg={c} />
      ))}
      {items.length === 0 && <div className="px-2 py-1 text-[12px] text-muted/70">Drag a connection here to remove it from its project.</div>}
    </div>
  );
}

function ConnectionNode({ cfg }: { cfg: ConnectionConfig }) {
  const state = useStore((s) => s.conn[cfg.id]);
  const selected = useStore((s) => s.selectedConnId === cfg.id);
  const { selectConnection, connectTo, disconnectFrom, removeConnection, setUi, refreshSchema, openContextMenu } = useStore.getState();
  const status = state?.status ?? "idle";
  // a selected, already connected connection starts expanded
  const [open, setOpen] = useState(() => selected && status === "connected");

  // collapse on disconnect
  useEffect(() => {
    if (status === "idle") setOpen(false);
    // connected elsewhere (Ctrl+K, running a query) while selected: expand
    if (status === "connected" && useStore.getState().selectedConnId === cfg.id) setOpen(true);
  }, [status, cfg.id]);

  const onClick = () => {
    selectConnection(cfg.id);
    if (status === "idle" || status === "error") {
      setOpen(true);
      void connectTo(cfg.id);
    } else setOpen((o) => !o);
  };

  const onDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (await ask(`Delete connection "${cfg.name}"?`, { title: "Delete connection", kind: "warning" })) {
      await removeConnection(cfg.id).catch((err) => alert(errorText(err)));
    }
  };

  const via = cfg.ssh?.enabled ? ` via ${cfg.ssh.host}` : "";
  const color = connColor(cfg);

  return (
    <div className="mb-0.5">
      <div
        onClick={onClick}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, cfg.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onContextMenu={(e) => {
          selectConnection(cfg.id);
          openContextMenu(e, connectionMenu(cfg));
        }}
        title={
          status === "error"
            ? state?.error
            : [
                `${cfg.user}@${cfg.host}:${cfg.port}${via}`,
                state?.info && `${state.info.version} · database ${state.info.database || "—"} · SSL ${state.info.ssl ? "on" : "off"}`,
              ]
                .filter(Boolean)
                .join("\n")
        }
        style={color ? { background: tint(color, selected ? 0.22 : 0.1), boxShadow: `inset 3px 0 0 ${color}` } : undefined}
        className={cx(
          "group relative flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 pl-1",
          !color && (selected ? "bg-accent-soft" : "hover:bg-hover"),
          color && "hover:brightness-125",
        )}
      >
        {open ? <ChevronDown size={14} className="shrink-0 text-muted" /> : <ChevronRight size={14} className="shrink-0 text-muted" />}
        <span className="relative shrink-0">
          <DbIcon kind={cfg.kind} size={20} />
          <span
            className={cx(
              "absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-panel",
              status === "connected" && "bg-ok",
              status === "connecting" && "animate-pulse bg-warn",
              status === "error" && "bg-err",
              status === "idle" && "bg-muted/70",
            )}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-fg">{cfg.name}</span>
            <EnvBadge cfg={cfg} />
          </div>
          <div className="truncate text-[11px] text-muted">
            {state?.info?.version ?? (cfg.kind === "postgres" ? "PostgreSQL" : "MySQL")} • {cfg.host}:{cfg.port}
            {via}
          </div>
        </div>
        <div className="absolute top-1 right-1 hidden items-center gap-0.5 rounded-md bg-raised/95 group-hover:flex">
          {status === "connected" && (
            <>
              <IconButton
                title="Refresh"
                onClick={(e) => {
                  e.stopPropagation();
                  void refreshSchema(cfg.id);
                  if (isMultiDb(cfg)) void useStore.getState().loadDatabases(cfg.id);
                }}
              >
                {state?.schemaLoading ? <Spinner /> : <RefreshCw size={14} />}
              </IconButton>
              <IconButton
                title="Disconnect"
                onClick={(e) => {
                  e.stopPropagation();
                  void disconnectFrom(cfg.id);
                }}
              >
                <Unplug size={14} />
              </IconButton>
            </>
          )}
          <IconButton
            title="Edit"
            onClick={(e) => {
              e.stopPropagation();
              setUi({ connDialog: { open: true, editing: cfg } });
            }}
          >
            <Pencil size={14} />
          </IconButton>
          <IconButton title="Delete" onClick={onDelete}>
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>

      {open && (
        <div>
          {status === "connecting" && <Note depth={1} spinner text="Connecting…" />}
          {status === "error" && (
            <div style={{ paddingLeft: indent(1) }} className="py-1.5 pr-2 text-[12px]">
              <p className="selectable break-words text-err">{state?.error}</p>
              <button className="mt-1 text-accent hover:underline" onClick={() => void connectTo(cfg.id)}>
                Retry
              </button>
            </div>
          )}
          {status === "connected" && isMultiDb(cfg) && <DatabaseList cfg={cfg} databases={state?.databases} />}
          {status === "connected" && !isMultiDb(cfg) && !state?.schema && <Note depth={1} spinner text="Loading schemas…" />}
          {status === "connected" && !isMultiDb(cfg) && state?.schema && <SchemaList cfg={cfg} schemas={state.schema.schemas} />}
          {status === "connected" && <UsersNode cfg={cfg} />}
        </div>
      )}
    </div>
  );
}

const indent = (depth: number) => 4 + depth * 16;

function Note({ depth, text, spinner }: { depth: number; text: string; spinner?: boolean }) {
  return (
    <div style={{ paddingLeft: indent(depth) + 18 }} className="flex items-center gap-2 py-1.5 text-[12px] text-muted">
      {spinner && <Spinner />}
      {text}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-3 py-3 text-[12px] text-muted">{text}</div>;
}

/** Filter inside an expanded list (schemas, tables, routines...). */
function InlineSearch({ depth, value, onChange, placeholder }: { depth: number; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div style={{ paddingLeft: indent(depth) + 18 }} className="py-1 pr-2">
      <SearchInput value={value} onChange={onChange} placeholder={placeholder} className="h-7" />
    </div>
  );
}

/** MySQL users or PostgreSQL roles, loaded when the node is expanded. */
function UsersNode({ cfg }: { cfg: ConnectionConfig }) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useStore((s) => s.usersVersion);
  const st = useStore.getState;
  const label = cfg.kind === "mysql" ? "Users" : "Roles";

  const load = useCallback(async () => {
    setError(null);
    try {
      setAccounts(await listAccounts(cfg.id, cfg.kind));
    } catch (e) {
      setError(errorText(e));
    }
  }, [cfg.id, cfg.kind]);
  useEffect(() => {
    if (open) void load();
  }, [open, version, load]);

  const show = (user?: string, drop?: boolean) => st().setUi({ usersDialog: { connId: cfg.id, user, drop } });
  const folderMenu = (e: React.MouseEvent) =>
    st().openContextMenu(e, [
      { label: cfg.kind === "mysql" ? "New user…" : "New role…", icon: <UserPlus />, onClick: () => show("new") },
      "sep",
      { label: "Refresh", icon: <RefreshCw />, onClick: () => (open ? void load() : setOpen(true)) },
    ]);
  const userMenu = (e: React.MouseEvent, key: string) =>
    st().openContextMenu(e, [
      { label: "Edit privileges…", icon: <UserCog />, onClick: () => show(key) },
      "sep",
      { label: "Delete…", icon: <Trash2 />, danger: true, onClick: () => show(key, true) },
    ]);

  return (
    <>
      <TreeRow depth={1} open={open} onClick={() => setOpen(!open)} onContextMenu={folderMenu}>
        <Users size={15} className="shrink-0 text-muted" />
        <span className="flex-1 truncate text-fg-2">{label}</span>
        {accounts && <span className="shrink-0 text-[11px] text-muted">{accounts.length}</span>}
      </TreeRow>
      {open &&
        (error ? (
          <Note depth={2} text={`Can't list ${label.toLowerCase()}: your account needs more rights.`} />
        ) : !accounts ? (
          <Note depth={2} spinner text="Loading…" />
        ) : (
          accounts.map((a) => {
            const key = accountKey(a);
            const group = a.kind === "postgres" && !a.login;
            return (
              <TreeRow key={key} depth={2} leaf title="Click to see privileges · right-click for more" onClick={() => show(key)} onContextMenu={(e) => userMenu(e, key)}>
                {group ? <Users size={14} className="shrink-0 text-violet-300" /> : <UserRound size={14} className="shrink-0 text-muted" />}
                <span className="flex-1 truncate">
                  {a.kind === "mysql" ? (
                    <>
                      {a.user || "(anonymous)"}
                      <span className="text-muted">@{a.host}</span>
                    </>
                  ) : (
                    a.name
                  )}
                </span>
                {a.kind === "mysql" && a.locked && <Lock size={12} className="shrink-0 text-warn" />}
                {a.kind === "postgres" && a.superuser && <span className="shrink-0 rounded bg-err/15 px-1 text-[9px] font-bold text-err">SUPER</span>}
              </TreeRow>
            );
          })
        ))}
    </>
  );
}

/** Databases on a PostgreSQL server; each one opens on its own. */
function DatabaseList({ cfg, databases }: { cfg: ConnectionConfig; databases?: DatabaseInfo[] }) {
  const [filter, setFilter] = useState("");
  if (!databases) return <Note depth={1} spinner text="Loading databases…" />;
  const visible = databases.filter((d) => matches(d.name, filter));
  return (
    <>
      {databases.length > 5 && <InlineSearch depth={1} value={filter} onChange={setFilter} placeholder="Filter databases..." />}
      {visible.map((d) => (
        <DatabaseNode key={d.name} cfg={cfg} db={d} />
      ))}
      {visible.length === 0 && <Note depth={1} text={databases.length ? `No databases match “${filter}”` : "No databases you can connect to"} />}
    </>
  );
}

function DatabaseNode({ cfg, db }: { cfg: ConnectionConfig; db: DatabaseInfo }) {
  // the schema subtree works on this database through its own id
  const dbCfg = useMemo(() => ({ ...cfg, id: subId(cfg.id, db.name), database: db.name }), [cfg, db.name]);
  const state = useStore((s) => s.conn[dbCfg.id]);
  const status = state?.status ?? "idle";
  const [open, setOpen] = useState(false);
  const { connectTo, openContextMenu } = useStore.getState();

  useEffect(() => {
    if (status === "idle") setOpen(false);
  }, [status]);

  const onClick = () => {
    if (!open && (status === "idle" || status === "error")) void connectTo(dbCfg.id);
    setOpen(!open);
  };

  return (
    <>
      <TreeRow
        depth={1}
        open={open}
        onClick={onClick}
        onContextMenu={(e) => openContextMenu(e, databaseMenu(dbCfg))}
        title={status === "error" ? state?.error : db.size === null ? "No CONNECT privilege" : undefined}
      >
        <span className="relative shrink-0">
          <Database size={15} className={status === "connected" ? "text-pg" : "text-muted"} />
          {status === "connecting" && <span className="absolute -right-0.5 -bottom-0.5 h-2 w-2 animate-pulse rounded-full bg-warn" />}
          {status === "error" && <span className="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full bg-err" />}
        </span>
        <span className={cx("flex-1 truncate", db.size === null && "text-muted")}>{db.name}</span>
        {db.size !== null && <span className="shrink-0 text-[11px] text-muted">{formatBytes(db.size)}</span>}
      </TreeRow>
      {open && (
        <>
          {status === "connecting" && <Note depth={2} spinner text="Connecting…" />}
          {status === "error" && (
            <div style={{ paddingLeft: indent(2) }} className="py-1.5 pr-2 text-[12px]">
              <p className="selectable break-words text-err">{state?.error}</p>
              <button className="mt-1 text-accent hover:underline" onClick={() => void connectTo(dbCfg.id)}>
                Retry
              </button>
            </div>
          )}
          {status === "connected" && !state?.schema && <Note depth={2} spinner text="Loading schemas…" />}
          {status === "connected" && state?.schema && <SchemaList cfg={dbCfg} schemas={state.schema.schemas} d={1} />}
        </>
      )}
    </>
  );
}

function SchemaList({ cfg, schemas, d = 0 }: { cfg: ConnectionConfig; schemas: SchemaInfo[]; d?: number }) {
  const [filter, setFilter] = useState("");
  const firstUser = defaultSchema(schemas);
  const visible = schemas.filter((s) => matches(s.name, filter));
  const word = cfg.kind === "mysql" ? "databases" : "schemas";
  return (
    <>
      {schemas.length > 5 && <InlineSearch depth={1 + d} value={filter} onChange={setFilter} placeholder={`Filter ${word}...`} />}
      {visible.map((s) => (
        <SchemaNode key={s.name} cfg={cfg} schema={s} defaultOpen={s.name === firstUser} d={d} />
      ))}
      {visible.length === 0 && <Note depth={1 + d} text={`No ${word} match “${filter}”`} />}
    </>
  );
}

/** First non-system schema with tables (else any non-system one). */
const defaultSchema = (schemas: SchemaInfo[]) => (schemas.find((s) => !s.system && s.tables.length) ?? schemas.find((s) => !s.system))?.name;

function SchemaNode({ cfg, schema: s, defaultOpen, d }: { cfg: ConnectionConfig; schema: SchemaInfo; defaultOpen: boolean; d: number }) {
  const focusOnClick = useStore((st) => !!st.settings.focusOnClick);
  const [open, setOpen] = useState(defaultOpen && !focusOnClick);
  const focus = () => useStore.getState().setFocus({ connId: cfg.id, schema: s.name, open: true });
  return (
    <>
      <TreeRow
        depth={1 + d}
        open={open}
        onClick={() => (focusOnClick ? focus() : setOpen(!open))}
        onContextMenu={(e) => useStore.getState().openContextMenu(e, schemaMenu(cfg, s.name))}
      >
        <SchemaIcon className={s.system ? "opacity-50" : "text-fg-2"} />
        <span className={cx("flex-1 truncate", s.system && "text-fg-2")}>{s.name}</span>
        <span className="shrink-0 text-[11px] text-muted group-hover/row:hidden">{s.tables.length || ""}</span>
        <button
          title="Focus: show only this schema"
          onClick={(e) => {
            e.stopPropagation();
            focus();
          }}
          className="hidden rounded p-0.5 text-muted group-hover/row:block hover:bg-hover hover:text-accent"
        >
          <Crosshair size={14} />
        </button>
      </TreeRow>
      {open &&
        CATEGORIES.map((c) => {
          const items = s[c.key];
          if (items.length === 0 && (c.key === "matViews" || c.key === "procedures" || c.key === "triggers")) return null;
          return <CategoryNode key={c.key} cfg={cfg} schema={s.name} category={c} items={items} stats={s.tableStats} d={d} />;
        })}
    </>
  );
}

function CategoryNode({
  cfg,
  schema,
  category,
  items,
  stats,
  d,
  defaultOpen,
}: {
  cfg: ConnectionConfig;
  schema: string;
  category: (typeof CATEGORIES)[number];
  items: string[];
  stats?: Record<string, TableStat>;
  d: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [filter, setFilter] = useState("");
  const { icon: Icon, label, kind } = category;
  const isRelation = kind === "table" || kind === "view" || kind === "matview";
  const visible = useMemo(() => items.filter((n) => matches(n, filter)), [items, filter]);
  const tip = useHoverTip();
  const st = useStore.getState;

  // Table Doctor dots: one schema scan once the table list is shown, again after a schema refresh
  const isTables = kind === "table";
  const badgesOn = useStore((s) => s.settings.doctorBadges !== false);
  const tree = useStore((s) => s.conn[cfg.id]?.schema);
  useEffect(() => {
    if (open && isTables && badgesOn) ensureBadges(cfg.id, schema);
  }, [open, isTables, badgesOn, tree, cfg.id, schema]);
  const health = useDoctor((s) => (isTables && badgesOn ? s.schemas[`${cfg.id}|${schema}`]?.tables : undefined));
  const ignoredMap = useStore((s) => s.doctorIgnored);

  const openTable = (name: string, structure = false) =>
    st().newTab({
      sql: `SELECT *\nFROM ${editorName(cfg.kind, schema, name)}\nLIMIT 100;`,
      connId: cfg.id,
      database: editorDb(cfg.kind, schema),
      title: `${name}.sql`,
      run: true,
      table: { schema, table: name },
      resultTab: structure ? "structure" : undefined,
    });

  const menu = (e: React.MouseEvent, items: MenuEntry[]) => st().openContextMenu(e, items);

  return (
    <>
      <TreeRow depth={2 + d} open={open} onClick={() => setOpen(!open)} onContextMenu={(e) => menu(e, categoryMenu(cfg, schema, category.key))}>
        <Icon size={15} className="text-muted" />
        <span>{label}</span>
        <span className="text-muted">({items.length})</span>
      </TreeRow>
      {open && (
        <>
          {items.length > SEARCH_FROM && (
            <InlineSearch depth={3 + d} value={filter} onChange={setFilter} placeholder={`Filter ${label.toLowerCase()}...`} />
          )}
          {visible.slice(0, MAX_ITEMS).map((name) => (
            <TreeRow
              key={name}
              depth={3 + d}
              leaf
              title={stats?.[name] ? undefined : isRelation ? "Double-click to open · right-click for more" : name}
              onMouseEnter={stats?.[name] ? (e) => tip.show(name, e.currentTarget) : undefined}
              onMouseLeave={tip.hide}
              onDoubleClick={() => isRelation && openTable(name)}
              onContextMenu={(e) => menu(e, isRelation ? tableMenu(cfg, schema, name, kind) : routineMenu(cfg, schema, name, kind))}
            >
              <Icon size={14} className="shrink-0 text-muted" />
              <span className="flex-1 truncate">
                <Highlight text={name} query={filter} />
              </span>
              {health?.[name] && (
                <HealthDot
                  findings={health[name].findings}
                  ignored={ignoredMap[refKey({ connId: cfg.id, schema, table: name })]}
                  onOpen={() => openDoctor(cfg.id, schema, name, editorDb(cfg.kind, schema))}
                />
              )}
              {isRelation && (
                <button
                  title="Open structure"
                  onClick={(e) => {
                    e.stopPropagation();
                    openTable(name, true);
                  }}
                  className="hidden rounded p-0.5 text-muted group-hover/row:block hover:bg-hover hover:text-accent"
                >
                  <TableProperties size={14} />
                </button>
              )}
            </TreeRow>
          ))}
          {visible.length > MAX_ITEMS && <Note depth={3 + d} text={`…and ${visible.length - MAX_ITEMS} more, type to filter`} />}
          {items.length > 0 && visible.length === 0 && <Note depth={3 + d} text={`Nothing matches “${filter}”`} />}
        </>
      )}
      {tip.state && stats?.[tip.state.name] && <TableTip name={tip.state.name} stat={stats[tip.state.name]} anchor={tip.state.el} />}
    </>
  );
}

/** One schema alone: breadcrumb with quick switchers, then its objects one level up. */
function FocusView({ focus }: { focus: TreeFocus }) {
  const base = useStore((s) => s.connections.find((c) => c.id === baseId(focus.connId)));
  const state = useStore((s) => s.conn[focus.connId]);
  const databases = useStore((s) => s.conn[baseId(focus.connId)!]?.databases);
  const db = dbOf(focus.connId);
  const cfg = useMemo(() => base && (db ? { ...base, id: focus.connId, database: db } : base), [base, focus.connId, db]);
  const [menu, setMenu] = useState<"db" | "schema" | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const { setFocus, connectTo } = useStore.getState();
  const status = state?.status ?? "idle";
  const schemas = state?.schema?.schemas;

  // focusing a whole database: pick its default schema once loaded
  useEffect(() => {
    if (!focus.schema && schemas?.length) setFocus({ ...focus, schema: defaultSchema(schemas) ?? schemas[0].name });
  }, [focus, schemas, setFocus]);

  if (!base || !cfg) return null;
  const schema = schemas?.find((s) => s.name === focus.schema);
  const color = connColor(base);
  const word = base.kind === "mysql" ? "database" : "schema";
  const back = () => setFocus({ ...focus, open: false });
  const menuOf = (items: MenuEntry[]) => (e: React.MouseEvent) => useStore.getState().openContextMenu(e, items);
  const schemaActions = schema ? menuOf(schemaMenu(cfg, schema.name)) : undefined;

  const openDbMenu = () => {
    const st = useStore.getState();
    if (st.conn[base.id]?.status !== "connected") void connectTo(base.id);
    else if (!databases) void st.loadDatabases(base.id);
    setMenu("db");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        style={color ? { boxShadow: `inset 3px 0 0 ${color}`, background: tint(color, 0.08) } : undefined}
        className="relative mx-2 mb-2 rounded-lg border border-line bg-hover/40 p-1"
      >
        <div className="flex items-center gap-1">
          <IconButton title="All connections" onClick={back}>
            <ArrowLeft size={15} />
          </IconButton>
          <button onClick={back} onContextMenu={menuOf(connectionMenu(base))} title="Back to all connections" className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hover">
            <DbIcon kind={base.kind} size={16} />
            <span className="truncate text-[13px] text-fg">{base.name}</span>
            <EnvBadge cfg={base} />
          </button>
          {schemaActions && (
            <IconButton title={`${word[0].toUpperCase()}${word.slice(1)} actions: new query, import, export, ER diagram…`} onClick={schemaActions}>
              <Ellipsis size={15} />
            </IconButton>
          )}
        </div>
        {db && <Crumb icon={<Database size={14} className="shrink-0 text-pg" />} label={db} title="Switch database" onClick={openDbMenu} onContextMenu={menuOf(databaseMenu(cfg))} />}
        <Crumb
          icon={<SchemaIcon className="text-fg-2" />}
          label={focus.schema || "…"}
          hint={schema ? `${schema.tables.length} tables` : undefined}
          title={`Switch ${word}`}
          onClick={() => setMenu("schema")}
          onContextMenu={schemaActions}
          disabled={!schemas}
        />
        {menu === "schema" && schemas && (
          <Switcher
            placeholder={`Switch ${word}...`}
            current={focus.schema}
            items={schemas.map((s) => ({ key: s.name, label: s.name, hint: s.tables.length ? String(s.tables.length) : "", dim: s.system }))}
            onPick={(name) => setFocus({ ...focus, schema: name })}
            onClose={closeMenu}
          />
        )}
        {menu === "db" && (
          <Switcher
            placeholder="Switch database..."
            current={db ?? ""}
            items={(databases ?? []).filter((d) => d.size !== null).map((d) => ({ key: d.name, label: d.name, hint: formatBytes(d.size!) }))}
            loading={!databases}
            onPick={(name) => {
              const id = subId(base.id, name);
              if (useStore.getState().conn[id]?.status !== "connected") void connectTo(id);
              setFocus({ connId: id, schema: "", open: true });
            }}
            onClose={closeMenu}
          />
        )}
      </div>
      <div onContextMenu={schemaActions} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 text-[13px]">
        {(status === "idle" || status === "error") && (
          <div className="px-3 py-2 text-[12px]">
            {status === "error" ? <p className="selectable mb-1 break-words text-err">{state?.error}</p> : <p className="mb-1 text-muted">Not connected.</p>}
            <button className="text-accent hover:underline" onClick={() => void connectTo(focus.connId)}>
              {status === "error" ? "Retry" : "Connect"}
            </button>
          </div>
        )}
        {status === "connecting" && <Note depth={0} spinner text="Connecting…" />}
        {status === "connected" && !schemas && <Note depth={0} spinner text="Loading…" />}
        {status === "connected" && schemas && focus.schema && !schema && <Note depth={0} text={`The ${word} “${focus.schema}” no longer exists.`} />}
        {status === "connected" &&
          schema &&
          CATEGORIES.map((c) => {
            const items = schema[c.key];
            if (items.length === 0 && (c.key === "matViews" || c.key === "procedures" || c.key === "triggers")) return null;
            return (
              <CategoryNode
                key={`${focus.connId}/${schema.name}/${c.key}`}
                cfg={cfg}
                schema={schema.name}
                category={c}
                items={items}
                stats={schema.tableStats}
                d={-2}
                defaultOpen={c.key === "tables"}
              />
            );
          })}
      </div>
    </div>
  );
}

function Crumb({
  icon,
  label,
  hint,
  title,
  onClick,
  onContextMenu,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  title: string;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      disabled={disabled}
      title={title}
      className="ml-7 flex w-[calc(100%-1.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hover disabled:opacity-60"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate font-medium text-fg">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-muted">{hint}</span>}
      <ChevronsUpDown size={13} className="shrink-0 text-muted" />
    </button>
  );
}

/** Searchable dropdown under the breadcrumb. */
function Switcher({
  items,
  current,
  placeholder,
  loading,
  onPick,
  onClose,
}: {
  items: { key: string; label: string; hint?: string; dim?: boolean }[];
  current: string;
  placeholder: string;
  loading?: boolean;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => items.filter((i) => matches(i.label, q)), [items, q]);

  useEffect(() => {
    input.current?.focus();
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [onClose]);
  useEffect(() => setHi(Math.max(0, visible.findIndex((i) => i.key === current))), [visible, current]);

  const pick = (key: string) => {
    onClose();
    if (key !== current) onPick(key);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") setHi((h) => Math.min(visible.length - 1, h + 1));
    else if (e.key === "ArrowUp") setHi((h) => Math.max(0, h - 1));
    else if (e.key === "Enter" && visible[hi]) pick(visible[hi].key);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={ref} onKeyDown={onKey} className="absolute top-full right-0 left-0 z-30 mt-1 rounded-lg border border-line-strong bg-raised p-1.5 shadow-xl">
      <SearchInput inputRef={input} value={q} onChange={setQ} placeholder={placeholder} className="h-7" />
      <div className="mt-1 max-h-72 overflow-y-auto text-[13px]">
        {loading && <Note depth={0} spinner text="Loading…" />}
        {visible.slice(0, MAX_ITEMS).map((i, n) => (
          <div
            key={i.key}
            ref={n === hi ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
            onMouseEnter={() => setHi(n)}
            onClick={() => pick(i.key)}
            className={cx("flex h-7 cursor-pointer items-center gap-2 rounded-md px-2", n === hi && "bg-hover")}
          >
            <span className={cx("min-w-0 flex-1 truncate", i.key === current ? "font-medium text-accent" : i.dim ? "text-fg-2" : "text-fg")}>
              <Highlight text={i.label} query={q} />
            </span>
            {i.hint && <span className="shrink-0 text-[11px] text-muted">{i.hint}</span>}
          </div>
        ))}
        {!loading && visible.length === 0 && <Note depth={0} text="Nothing matches." />}
      </div>
    </div>
  );
}

/** Highlights the part matching the filter. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-accent/30 text-fg">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

function TreeRow({
  depth,
  open,
  leaf,
  children,
  ...rest
}: {
  depth: number;
  open?: boolean;
  leaf?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title?: string;
  onMouseEnter?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseLeave?: () => void;
}) {
  return (
    <div {...rest} style={{ paddingLeft: indent(depth) }} className="group/row flex h-7 cursor-pointer items-center gap-2 rounded-md pr-2 hover:bg-hover">
      {leaf ? <span className="w-[14px] shrink-0" /> : open ? <ChevronDown size={14} className="shrink-0 text-muted" /> : <ChevronRight size={14} className="shrink-0 text-muted" />}
      {children}
    </div>
  );
}

const totalBytes = (s?: TableStat) => (s ? s.dataBytes + s.indexBytes : 0);

/** Delayed hover tooltip. */
/** Red (critical) or amber (warning) dot for a table with Table Doctor findings; opens Table Doctor. */
function HealthDot({ findings, ignored, onOpen }: { findings: Finding[]; ignored?: string[]; onOpen: () => void }) {
  const active = ignored ? findings.filter((f) => !ignored.includes(f.id)) : findings;
  const critical = active.filter((f) => f.severity === "critical").length;
  const warning = active.filter((f) => f.severity === "warning").length;
  if (!critical && !warning) return null;
  const parts = [critical && `${critical} critical`, warning && `${warning} warning${warning > 1 ? "s" : ""}`].filter(Boolean).join(", ");
  return (
    <button
      title={`Table Doctor: ${parts} — click to open`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="shrink-0 rounded-full p-1 hover:bg-hover"
    >
      <span className={cx("block h-2 w-2 rounded-full", critical ? "bg-err" : "bg-warn")} />
    </button>
  );
}

function useHoverTip() {
  const [state, setState] = useState<{ name: string; el: HTMLElement } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setState(null);
  }, []);
  const show = (name: string, el: HTMLElement) => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState({ name, el }), 450);
  };
  useEffect(() => {
    if (!state) return;
    // click, scroll or right click hide it
    window.addEventListener("mousedown", hide, true);
    window.addEventListener("wheel", hide, true);
    return () => {
      window.removeEventListener("mousedown", hide, true);
      window.removeEventListener("wheel", hide, true);
    };
  }, [state, hide]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { state, show, hide };
}

function TableTip({ name, stat, anchor }: { name: string; stat: TableStat; anchor: HTMLElement }) {
  const r = anchor.getBoundingClientRect();
  const total = totalBytes(stat);
  const dataPct = total > 0 ? (stat.dataBytes / total) * 100 : 100;
  const top = Math.min(r.top - 6, window.innerHeight - 190);
  return createPortal(
    <div
      style={{ left: r.right + 10, top: Math.max(8, top) }}
      className="pointer-events-none fixed z-[80] w-[250px] animate-[tip-in_140ms_ease-out] rounded-xl border border-line-strong bg-raised p-3 shadow-2xl shadow-black/50"
    >
      <div className="flex items-center gap-2">
        <Sheet size={14} className="shrink-0 text-accent" />
        <span className="truncate text-[13px] font-semibold text-fg">{name}</span>
      </div>
      <div className="mt-2.5 flex items-baseline gap-1.5">
        <span className="text-[20px] font-semibold tabular-nums leading-none text-fg">{formatBytes(total)}</span>
        <span className="text-[12px] text-muted">
          {stat.rows === null ? "· rows not analyzed yet" : `· ~${stat.rows.toLocaleString()} rows`}
        </span>
      </div>
      <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-hover">
        <span className="bg-accent" style={{ width: `${dataPct}%` }} />
        <span className="bg-violet-400/80" style={{ width: `${100 - dataPct}%` }} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11.5px]">
        <TipStat color="bg-accent" label="Data" value={formatBytes(stat.dataBytes)} />
        <TipStat color="bg-violet-400/80" label="Indexes" value={formatBytes(stat.indexBytes)} />
      </div>
      <div className="mt-3 border-t border-line pt-2 text-[11px] text-muted">Double-click to open · right-click for more</div>
    </div>,
    document.body,
  );
}

function TipStat({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={cx("h-2 w-2 rounded-sm", color)} />
      <span className="text-muted">{label}</span>
      <span className="ml-auto font-medium tabular-nums text-fg-2">{value}</span>
    </div>
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function timeAgo(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}
