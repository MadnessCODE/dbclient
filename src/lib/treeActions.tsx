// Context menu actions for schema tree objects and connections.
import {
  ClipboardCopy,
  Code,
  Copy,
  Crosshair,
  Database,
  DatabaseBackup,
  Eraser,
  FileCode,
  FileSpreadsheet,
  FileUp,
  UserCog,
  FolderInput,
  FolderX,
  Hash,
  Network,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  TableProperties,
  Trash2,
  Unplug,
} from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorText, kindLabel, type ConnectionConfig, type DbKind } from "./api";
import { quoteIdent } from "./sql";
import { useStore, type MenuEntry } from "../store";
import { baseId, dbOf, isMultiDb, subId } from "./connIds";
import { isProduction } from "./connStyle";

export type ObjectKind = "table" | "view" | "matview" | "function" | "procedure" | "trigger";

const st = () => useStore.getState();
const copy = (text: string) => void navigator.clipboard.writeText(text);

function fq(kind: DbKind, schema: string, name: string) {
  return `${quoteIdent(schema, kind)}.${quoteIdent(name, kind)}`;
}

function openSql(connId: string, sql: string, title: string, opts: { run?: boolean; schema?: string; table?: string; structure?: boolean } = {}) {
  st().newTab({
    sql,
    connId,
    title,
    run: opts.run,
    table: opts.schema && opts.table ? { schema: opts.schema, table: opts.table } : undefined,
    resultTab: opts.structure ? "structure" : undefined,
  });
}

/** Detaches tabs from a dropped/renamed table (the SQL stays). */
function forgetTable(connId: string, schema: string, table: string) {
  for (const t of st().tabs) {
    if (t.connId === connId && t.table?.schema === schema && t.table.table === table) st().updateTab(t.id, { table: undefined });
  }
}


export function tableMenu(cfg: ConnectionConfig, schema: string, name: string, kind: ObjectKind): MenuEntry[] {
  const k = cfg.kind;
  const full = fq(k, schema, name);
  const connId = cfg.id;
  const isTable = kind === "table";
  const dropKw = kind === "view" ? "VIEW" : kind === "matview" ? "MATERIALIZED VIEW" : "TABLE";

  const scriptAs = async (what: "select" | "insert" | "update" | "delete" | "create") => {
    try {
      const s = await api.getTableStructure(connId, schema, name);
      const cols = s.columns.map((c) => quoteIdent(c.name, k));
      const pk = s.columns.filter((c) => c.primaryKey).map((c) => quoteIdent(c.name, k));
      const where = (pk.length ? pk : cols.slice(0, 1)).map((c) => `${c} = ?`).join("\n  AND ");
      const sql = {
        select: `SELECT\n    ${cols.join(",\n    ")}\nFROM ${full}\nLIMIT 100;`,
        insert: `INSERT INTO ${full} (\n    ${cols.join(",\n    ")}\n) VALUES (\n    ${cols.map(() => "?").join(",\n    ")}\n);`,
        update: `UPDATE ${full}\nSET\n    ${cols.filter((c) => !pk.includes(c)).map((c) => `${c} = ?`).join(",\n    ")}\nWHERE ${where};`,
        delete: `DELETE FROM ${full}\nWHERE ${where};`,
        create: s.ddl,
      }[what];
      openSql(connId, sql, `${name}_${what}.sql`, { schema, table: name });
    } catch (e) {
      alert(errorText(e));
    }
  };

  const exportData = async () => {
    try {
      const out = await api.runQuery(connId, crypto.randomUUID(), `SELECT * FROM ${full}`, st().settings.maxRows);
      const rs = out.resultSets[0];
      if (rs) st().setUi({ exportJob: { rs, name, kind: cfg.kind, connId, sql: `SELECT * FROM ${full}` } });
    } catch (e) {
      alert(errorText(e));
    }
  };

  const items: MenuEntry[] = [
    { label: "Open (first 100 rows)", icon: <Play />, onClick: () => openSql(connId, `SELECT *\nFROM ${full}\nLIMIT 100;`, `${name}.sql`, { run: true, schema, table: name }) },
    { label: "Structure", icon: <TableProperties />, onClick: () => openSql(connId, `SELECT *\nFROM ${full}\nLIMIT 100;`, `${name}.sql`, { run: true, schema, table: name, structure: true }) },
    { label: "Count rows", icon: <Hash />, onClick: () => openSql(connId, `SELECT COUNT(*) AS total\nFROM ${full};`, `${name}_count.sql`, { run: true, schema, table: name }) },
    "sep",
    {
      label: "Script as",
      icon: <Code />,
      children: [
        { label: "SELECT", onClick: () => void scriptAs("select") },
        { label: "INSERT", onClick: () => void scriptAs("insert"), disabled: !isTable },
        { label: "UPDATE", onClick: () => void scriptAs("update"), disabled: !isTable },
        { label: "DELETE", onClick: () => void scriptAs("delete"), disabled: !isTable },
        "sep",
        { label: isTable ? "CREATE TABLE" : "CREATE VIEW", onClick: () => void scriptAs("create") },
      ],
    },
    {
      label: "Copy",
      icon: <Copy />,
      children: [
        { label: "Name", onClick: () => copy(name) },
        { label: "Full name (schema.table)", onClick: () => copy(full) },
        { label: "DDL (CREATE …)", onClick: () => void api.getTableStructure(connId, schema, name).then((s) => copy(s.ddl), (e) => alert(errorText(e))) },
      ],
    },
    { label: "Export data…", icon: <FileSpreadsheet />, onClick: () => void exportData() },
    "sep",
  ];

  if (isTable) {
    items.push(
      {
        label: "Rename…",
        icon: <Pencil />,
        onClick: () =>
          st().setUi({
            actionDialog: {
              title: `Rename ${name}`,
              connId,
              confirmLabel: "Rename",
              input: { label: "New name", value: name },
              buildSql: (n) => (k === "mysql" ? `RENAME TABLE ${full} TO ${fq(k, schema, n)};` : `ALTER TABLE ${full} RENAME TO ${quoteIdent(n, k)};`),
              afterRun: () => forgetTable(connId, schema, name),
            },
          }),
      },
      {
        label: "Duplicate",
        icon: <ClipboardCopy />,
        children: [
          { label: "Structure only…", onClick: () => duplicate(cfg, schema, name, false) },
          { label: "Structure and data…", onClick: () => duplicate(cfg, schema, name, true) },
        ],
      },
      {
        label: "Truncate…",
        icon: <Eraser />,
        danger: true,
        onClick: () =>
          st().setUi({
            actionDialog: {
              title: `Truncate ${name}`,
              connId,
              danger: true,
              confirmLabel: "Truncate",
              message: `All rows in ${schema}.${name} will be permanently deleted. The table itself stays.`,
              buildSql: () => `TRUNCATE TABLE ${full};`,
            },
          }),
      },
    );
  }
  items.push({
    label: `Drop ${kind === "table" ? "table" : "view"}…`,
    icon: <Trash2 />,
    danger: true,
    onClick: () =>
      st().setUi({
        actionDialog: {
          title: `Drop ${name}`,
          connId,
          danger: true,
          confirmLabel: "Drop",
          message: `${schema}.${name} and all its data will be permanently deleted. This cannot be undone.`,
          buildSql: () => `DROP ${dropKw} ${full};`,
          afterRun: () => forgetTable(connId, schema, name),
        },
      }),
  });
  return items;
}

function duplicate(cfg: ConnectionConfig, schema: string, name: string, withData: boolean) {
  const k = cfg.kind;
  const src = fq(k, schema, name);
  st().setUi({
    actionDialog: {
      title: `Duplicate ${name}`,
      connId: cfg.id,
      confirmLabel: "Create copy",
      input: { label: "New table name", value: `${name}_copy` },
      buildSql: (n) => {
        const dst = fq(k, schema, n);
        const create = k === "mysql" ? `CREATE TABLE ${dst} LIKE ${src};` : `CREATE TABLE ${dst} (LIKE ${src} INCLUDING ALL);`;
        return withData ? `${create}\nINSERT INTO ${dst} SELECT * FROM ${src};` : create;
      },
    },
  });
}


export function routineMenu(cfg: ConnectionConfig, schema: string, name: string, kind: ObjectKind): MenuEntry[] {
  const k = cfg.kind;
  const full = fq(k, schema, name);
  const kw = kind === "procedure" ? "PROCEDURE" : kind === "trigger" ? "TRIGGER" : "FUNCTION";
  const call = kind === "procedure" ? `CALL ${full}();` : `SELECT ${full}();`;
  const items: MenuEntry[] = [];
  if (kind !== "trigger") items.push({ label: kind === "procedure" ? "Script CALL" : "Script SELECT", icon: <Play />, onClick: () => openSql(cfg.id, call, `${name}.sql`) });
  items.push({ label: "Copy name", icon: <Copy />, onClick: () => copy(name) }, "sep", {
    label: `Drop ${kind}…`,
    icon: <Trash2 />,
    danger: true,
    // a Postgres trigger needs "ON table", which isn't known here
    disabled: kind === "trigger" && k === "postgres",
    hint: kind === "trigger" && k === "postgres" ? "Use DROP TRIGGER name ON table in the editor" : undefined,
    onClick: () =>
      st().setUi({
        actionDialog: {
          title: `Drop ${name}`,
          connId: cfg.id,
          danger: true,
          confirmLabel: "Drop",
          message: `${kw.toLowerCase()} ${schema}.${name} will be permanently deleted.`,
          buildSql: () => `DROP ${kw} ${full};`,
        },
      }),
  });
  return items;
}


export function schemaMenu(cfg: ConnectionConfig, schema: string): MenuEntry[] {
  const k = cfg.kind;
  const word = k === "mysql" ? "database" : "schema";
  const Word = k === "mysql" ? "Database" : "Schema";
  const s = quoteIdent(schema, k);
  const f = st().focus;
  const focused = !!f?.open && f.connId === cfg.id && f.schema === schema;
  return [
    ...(focused ? [] : ([{ label: "Focus", icon: <Crosshair />, onClick: () => st().setFocus({ connId: cfg.id, schema, open: true }) }, "sep"] as MenuEntry[])),
    { label: "New query", icon: <FileCode />, onClick: () => openSql(cfg.id, k === "mysql" ? `USE ${s};\n\n` : `SET search_path TO ${s};\n\n`, `${schema}.sql`) },
    { label: "Create table…", icon: <Plus />, onClick: () => openSql(cfg.id, createTableTemplate(k, schema), "new_table.sql") },
    { label: `Create ${word}…`, icon: <Database />, onClick: () => createSchema(cfg) },
    "sep",
    { label: "ER diagram…", icon: <Network />, onClick: () => st().setUi({ erDialog: { connId: cfg.id, schema } }) },
    { label: `Import into ${schema}…`, icon: <FileUp />, onClick: () => st().setUi({ importDialog: { connId: cfg.id, database: schema } }) },
    { label: `Export ${word}…`, icon: <DatabaseBackup />, onClick: () => st().setUi({ dbExport: { connId: cfg.id, schema } }) },
    "sep",
    { label: "Copy name", icon: <Copy />, onClick: () => copy(schema) },
    { label: "Refresh", icon: <RefreshCw />, onClick: () => void st().refreshSchema(cfg.id) },
    "sep",
    ...clearItems(cfg, cfg.id, schema, () => [schema], word),
    {
      label: `Drop ${word}…`,
      icon: <Trash2 />,
      danger: true,
      onClick: () =>
        st().setUi({
          actionDialog: {
            title: `Drop ${word} ${schema}`,
            connId: cfg.id,
            danger: true,
            confirmLabel: `Drop ${word}`,
            message: `${Word} "${schema}" with ALL its tables and data will be permanently deleted. Type the name to confirm.`,
            input: { label: `Type "${schema}" to confirm`, value: "" },
            requireInput: schema,
            buildSql: () => (k === "mysql" ? `DROP DATABASE ${s};` : `DROP SCHEMA ${s} CASCADE;`),
          },
        }),
    },
  ];
}

export function categoryMenu(cfg: ConnectionConfig, schema: string, category: string): MenuEntry[] {
  const items: MenuEntry[] = [];
  if (category === "tables") items.push({ label: "Create table…", icon: <Plus />, onClick: () => openSql(cfg.id, createTableTemplate(cfg.kind, schema), "new_table.sql") });
  if (category === "views")
    items.push({
      label: "Create view…",
      icon: <Plus />,
      onClick: () => openSql(cfg.id, `CREATE VIEW ${fq(cfg.kind, schema, "new_view")} AS\nSELECT *\nFROM ${quoteIdent(schema, cfg.kind)}.table_name;`, "new_view.sql"),
    });
  items.push({ label: "Refresh", icon: <RefreshCw />, onClick: () => void st().refreshSchema(cfg.id) });
  return items;
}

function createTableTemplate(k: DbKind, schema: string) {
  const t = fq(k, schema, "new_table");
  return k === "postgres"
    ? `CREATE TABLE ${t} (\n    id         bigserial PRIMARY KEY,\n    name       varchar(100) NOT NULL,\n    created_at timestamp NOT NULL DEFAULT now()\n);`
    : `CREATE TABLE ${t} (\n    id         BIGINT AUTO_INCREMENT PRIMARY KEY,\n    name       VARCHAR(100) NOT NULL,\n    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n);`;
}

function createSchema(cfg: ConnectionConfig) {
  const k = cfg.kind;
  st().setUi({
    actionDialog: {
      title: k === "mysql" ? "Create database" : "Create schema",
      connId: cfg.id,
      confirmLabel: "Create",
      input: { label: "Name", value: "" },
      buildSql: (n) =>
        k === "mysql" ? `CREATE DATABASE ${quoteIdent(n || "new_database", k)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;` : `CREATE SCHEMA ${quoteIdent(n || "new_schema", k)};`,
    },
  });
}


function createDatabase(cfg: ConnectionConfig) {
  st().setUi({
    actionDialog: {
      title: "Create database",
      connId: cfg.id,
      confirmLabel: "Create",
      input: { label: "Name", value: "" },
      buildSql: (n) => `CREATE DATABASE ${quoteIdent(n || "new_database", "postgres")};`,
      afterRun: () => void st().loadDatabases(cfg.id),
    },
  });
}

/** A database on a PostgreSQL server listed under its connection (`cfg.id` is "<connection>::<database>"). */
export function databaseMenu(cfg: ConnectionConfig): MenuEntry[] {
  const server = baseId(cfg.id)!;
  const db = dbOf(cfg.id)!;
  const connected = st().conn[cfg.id]?.status === "connected";
  const q = quoteIdent(db, "postgres");
  return [
    connected
      ? { label: "Disconnect", icon: <Unplug />, onClick: () => void st().disconnectFrom(cfg.id) }
      : { label: "Connect", icon: <Plug />, onClick: () => void st().connectTo(cfg.id) },
    { label: "Focus", icon: <Crosshair />, onClick: () => st().setFocus({ connId: cfg.id, schema: "", open: true }) },
    { label: "New query", icon: <FileCode />, onClick: () => st().newTab({ connId: cfg.id, title: `${db}.sql` }) },
    { label: "Refresh", icon: <RefreshCw />, disabled: !connected, onClick: () => void st().refreshSchema(cfg.id) },
    { label: "Create schema…", icon: <Database />, disabled: !connected, onClick: () => createSchema(cfg) },
    "sep",
    { label: `Import into ${db}…`, icon: <FileUp />, disabled: !connected, onClick: () => st().setUi({ importDialog: { connId: cfg.id } }) },
    { label: "Export database…", icon: <DatabaseBackup />, onClick: () => st().setUi({ dbExport: { connId: cfg.id } }) },
    { label: "Users & privileges…", icon: <UserCog />, disabled: !connected, onClick: () => st().setUi({ usersDialog: { connId: cfg.id } }) },
    "sep",
    { label: "Copy name", icon: <Copy />, onClick: () => copy(db) },
    { label: "Rename database…", icon: <Pencil />, onClick: () => renameDatabase(cfg) },
    "sep",
    ...clearItems(cfg, cfg.id, db, () => (st().conn[cfg.id]?.schema?.schemas ?? []).filter((s) => !s.system).map((s) => s.name), "database", !connected),
    {
      label: "Drop database…",
      icon: <Trash2 />,
      danger: true,
      onClick: () =>
        st().setUi({
          actionDialog: {
            title: `Drop database ${db}`,
            connId: server,
            danger: true,
            confirmLabel: "Drop database",
            message: `Database "${db}" with ALL its schemas and data will be permanently deleted. Type the name to confirm.`,
            input: { label: `Type "${db}" to confirm`, value: "" },
            requireInput: db,
            buildSql: () => `DROP DATABASE ${q};`,
            // our own connections to it would block the drop
            beforeRun: () => st().disconnectFrom(cfg.id),
            afterRun: () => void st().loadDatabases(server),
          },
        }),
    },
  ];
}

/**
 * PostgreSQL refuses to rename a database while anyone is connected to it, so the SQL first
 * terminates those sessions (ALTER DATABASE then waits a few seconds for them to exit).
 */
function renameDatabase(cfg: ConnectionConfig) {
  const server = baseId(cfg.id)!;
  const db = dbOf(cfg.id)!;
  const prod = isProduction(st().connections.find((c) => c.id === server));
  const lit = `'${db.replace(/'/g, "''")}'`;
  let renamedTo = "";
  st().setUi({
    actionDialog: {
      title: `Rename database ${db}`,
      connId: server,
      danger: true,
      confirmLabel: "Rename database",
      message: `Every open connection to "${db}" will be terminated first, including other users and applications; their running queries and open transactions are rolled back. Connection settings that point to "${db}" by name stop working after the rename.`,
      input: { label: "New name", value: db },
      hideSql: true,
      acknowledge: prod ?`I understand that all sessions on the production database "${db}" will be terminated.` : undefined,
      buildSql: (n) => {
        renamedTo = n;
        return [
          `SELECT pg_terminate_backend(pid)\n  FROM pg_stat_activity\n WHERE datname = ${lit} AND pid <> pg_backend_pid();`,
          `ALTER DATABASE ${quoteIdent(db, "postgres")} RENAME TO ${quoteIdent(n, "postgres")};`,
        ].join("\n");
      },
      beforeRun: () => st().disconnectFrom(cfg.id),
      afterRun: () => {
        // move open tabs over to the renamed database
        const to = subId(server, renamedTo);
        for (const t of st().tabs) if (t.connId === cfg.id) st().updateTab(t.id, { connId: to });
        if (st().focus?.connId === cfg.id) st().setFocus(null);
        void st().loadDatabases(server);
      },
    },
  });
}

/** Always-quoted identifier (generated lists may contain reserved words). */
function qi(name: string, k: DbKind) {
  return k === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}

/**
 * "Truncate" (delete all rows, keep the structure) and "Empty" (drop every object, keep the
 * database) for a MySQL database, a Postgres schema or a Postgres database. Hidden on production.
 */
function clearItems(cfg: ConnectionConfig, connId: string, name: string, schemas: () => string[], word: string, disabled = false): MenuEntry[] {
  if (isProduction(st().connections.find((c) => c.id === baseId(cfg.id)))) return [];
  const open = async (mode: "truncate" | "empty") => {
    // the tree may be stale; the SQL lists objects from it
    await st().refreshSchema(connId);
    const names = schemas();
    const infos = (st().conn[connId]?.schema?.schemas ?? []).filter((s) => names.includes(s.name));
    const tables = infos.flatMap((s) => s.tables.map((t) => `${qi(s.name, cfg.kind)}.${qi(t, cfg.kind)}`));
    const truncate = mode === "truncate";
    const sql = truncate ? truncateSql(cfg.kind, tables) : emptySql(cfg.kind, names, infos);
    const count = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const views = infos.reduce((a, s) => a + s.views.length + s.matViews.length, 0);
    const routines = infos.reduce((a, s) => a + s.functions.length + s.procedures.length, 0);
    st().setUi({
      actionDialog: {
        title: `${truncate ? "Truncate" : "Empty"} ${word} ${name}`,
        connId,
        danger: true,
        confirmLabel: truncate ? "Truncate all tables" : `Empty ${word}`,
        message: truncate
          ? `All rows in ${count(tables.length, "table")} of "${name}" will be permanently deleted. Tables, views and routines stay. Type the name to confirm.`
          : `${count(tables.length, "table")}, ${count(views, "view")} and ${count(routines, "routine")} in "${name}" will be permanently dropped${cfg.kind === "postgres" ? ", along with sequences and types" : ""}. The ${word} itself stays. Type the name to confirm.`,
        input: { label: `Type "${name}" to confirm`, value: "" },
        requireInput: name,
        buildSql: () => sql,
      },
    });
  };
  return [
    { label: `Truncate ${word}…`, icon: <Eraser />, danger: true, disabled, onClick: () => void open("truncate") },
    { label: `Empty ${word}…`, icon: <FolderX />, danger: true, disabled, onClick: () => void open("empty") },
  ];
}

function truncateSql(k: DbKind, tables: string[]) {
  if (!tables.length) return "-- no tables";
  if (k === "postgres") return `TRUNCATE TABLE\n  ${tables.join(",\n  ")}\nRESTART IDENTITY CASCADE;`;
  return ["SET FOREIGN_KEY_CHECKS = 0;", ...tables.map((t) => `TRUNCATE TABLE ${t};`), "SET FOREIGN_KEY_CHECKS = 1;"].join("\n");
}

type ClearInfo = { name: string; tables: string[]; views: string[]; procedures: string[]; functions: string[] };

function emptySql(k: DbKind, names: string[], infos: ClearInfo[]) {
  if (k === "mysql") {
    const drops = (kw: string, pick: (s: ClearInfo) => string[]) => infos.flatMap((s) => pick(s).map((o) => `DROP ${kw} IF EXISTS ${qi(s.name, k)}.${qi(o, k)};`));
    return [
      "SET FOREIGN_KEY_CHECKS = 0;",
      ...drops("VIEW", (s) => s.views),
      ...drops("TABLE", (s) => s.tables),
      ...drops("PROCEDURE", (s) => s.procedures),
      ...drops("FUNCTION", (s) => s.functions),
      "SET FOREIGN_KEY_CHECKS = 1;",
    ].join("\n");
  }
  // Postgres: from the catalog, so overloaded routines, sequences and types are covered and
  // objects that belong to extensions are left alone
  const list = names.map((n) => `'${n.replace(/'/g, "''")}'`).join(", ");
  return `DO $clear$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT format('DROP %s IF EXISTS %I.%I CASCADE',
             CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
             n.nspname, c.relname) AS stmt, 1 AS ord
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN (${list}) AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND NOT c.relispartition
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
    UNION ALL
    SELECT format('DROP %s IF EXISTS %s CASCADE', CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END, p.oid::regprocedure), 2
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN (${list}) AND p.prokind IN ('f', 'p', 'a')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    UNION ALL
    SELECT format('DROP %s IF EXISTS %I.%I CASCADE', CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, n.nspname, t.typname), 3
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname IN (${list}) AND t.typtype IN ('e', 'd', 'r', 'c')
       AND (t.typtype <> 'c' OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
    ORDER BY ord
  LOOP
    EXECUTE r.stmt;
  END LOOP;
END $clear$;`;
}

export function connectionMenu(cfg: ConnectionConfig): MenuEntry[] {
  const status = st().conn[cfg.id]?.status;
  const connected = status === "connected";
  return [
    connected
      ? { label: "Disconnect", icon: <Unplug />, onClick: () => void st().disconnectFrom(cfg.id) }
      : { label: "Connect", icon: <Plug />, onClick: () => (st().selectConnection(cfg.id), void st().connectTo(cfg.id)) },
    { label: "New query", icon: <FileCode />, onClick: () => st().newTab({ connId: cfg.id }) },
    {
      label: "Refresh",
      icon: <RefreshCw />,
      disabled: !connected,
      onClick: () => (isMultiDb(cfg) ? void st().loadDatabases(cfg.id) : void st().refreshSchema(cfg.id)),
    },
    connected
      ? isMultiDb(cfg)
        ? { label: "Create database…", icon: <Database />, onClick: () => createDatabase(cfg) }
        : { label: `Create ${cfg.kind === "mysql" ? "database" : "schema"}…`, icon: <Database />, onClick: () => createSchema(cfg) }
      : "sep",
    { label: "Import…", icon: <FileUp />, disabled: !connected, onClick: () => st().setUi({ importDialog: { connId: cfg.id } }) },
    ...(cfg.kind === "postgres" && !isMultiDb(cfg)
      ? [{ label: "Export database…", icon: <DatabaseBackup />, disabled: !connected, onClick: () => st().setUi({ dbExport: { connId: cfg.id } }) } as MenuEntry]
      : []),
    { label: "Users & privileges…", icon: <UserCog />, disabled: !connected, onClick: () => st().setUi({ usersDialog: { connId: cfg.id } }) },
    "sep",
    { label: "Edit…", icon: <Pencil />, onClick: () => st().setUi({ connDialog: { open: true, editing: cfg } }) },
    {
      label: "Duplicate",
      icon: <ClipboardCopy />,
      onClick: async () => {
        try {
          const copyCfg = await api.saveConnection({ ...cfg, id: "", name: `${cfg.name} (copy)`, savePassword: false, password: null, sshSecret: null });
          st().upsertConnection(copyCfg);
        } catch (e) {
          alert(errorText(e));
        }
      },
    },
    {
      label: "Move to project",
      icon: <FolderInput />,
      children: [
        ...[...st().projects]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (p): MenuEntry => ({
              label: `${p.id === cfg.projectId ? "✓ " : ""}${p.icon?.type === "emoji" ? `${p.icon.value} ` : ""}${p.name}`,
              disabled: p.id === cfg.projectId,
              onClick: () => void st().moveConnections([cfg.id], p.id),
            }),
          ),
        ...(st().projects.length ? (["sep"] as MenuEntry[]) : []),
        { label: "No project", disabled: !cfg.projectId, onClick: () => void st().moveConnections([cfg.id], null) },
        { label: "New project…", onClick: () => st().setUi({ projectDialog: { open: true } }) },
      ],
    },
    { label: "Copy host:port", icon: <Copy />, onClick: () => copy(`${cfg.host}:${cfg.port}`) },
    "sep",
    {
      label: "Delete connection…",
      icon: <Trash2 />,
      danger: true,
      onClick: async () => {
        if (await ask(`Delete connection "${cfg.name}" (${kindLabel(cfg.kind)})? The database itself is not affected.`, { title: "Delete connection", kind: "warning" })) {
          await st().removeConnection(cfg.id).catch((e) => alert(errorText(e)));
        }
      },
    },
  ];
}

