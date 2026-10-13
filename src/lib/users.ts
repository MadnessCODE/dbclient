// Users and privileges: loading from the server and turning edits into SQL (MySQL and PostgreSQL).
import { api, type DbKind } from "./api";


export interface MyAccount {
  user: string;
  host: string;
  plugin: string;
  locked: boolean;
  /** Not created yet */
  isNew?: boolean;
}

export interface PgRole {
  name: string;
  login: boolean;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  replication: boolean;
  bypassrls: boolean;
  inherit: boolean;
  connLimit: number;
  validUntil: string | null;
  memberOf: string[];
  isNew?: boolean;
}

export type Account = ({ kind: "mysql" } & MyAccount) | ({ kind: "postgres" } & PgRole);

export const accountKey = (a: Account) => (a.kind === "mysql" ? `${a.user}@${a.host}` : a.name);

/** Scope key -> privileges. */
export type PrivMap = Record<string, string[]>;

/** PostgreSQL: how many tables/sequences in a schema have each privilege, out of the total. */
export interface PgObjectPrivs {
  total: number;
  /** Owned by this role (all privileges implicitly) */
  owned: number;
  counts: Record<string, number>;
}

export interface Privileges {
  /** MySQL: "*" = global, else a database. PostgreSQL: "db" = database, "schema:<name>" = schema. */
  granted: PrivMap;
  /** PostgreSQL: "tables:<schema>" and "sequences:<schema>" */
  objects: Record<string, PgObjectPrivs>;
  /** PostgreSQL: schemas whose default privileges cover new tables */
  futureTables: string[];
  /** PostgreSQL: schemas owned by the role */
  ownedSchemas: string[];
  /** Per table/view grants: objKey(database or schema, name) -> privileges */
  objectGrants: Record<string, string[]>;
  /** PostgreSQL: objects (objKey) owned by the role */
  ownedObjects: string[];
  /** MySQL: column-level and other grants that are shown but not edited */
  other: string[];
  raw: string[];
}

export const emptyPrivileges = (): Privileges => ({ granted: {}, objects: {}, objectGrants: {}, ownedObjects: [], futureTables: [], ownedSchemas: [], other: [], raw: [] });

/** Database (MySQL) or schema (PostgreSQL) + table/view name. */
export const objKey = (scope: string, name: string) => `${scope}\u0001${name}`;
export const splitObjKey = (k: string) => k.split("\u0001") as [string, string];

/** Privileges offered for single tables and views. */
export const OBJECT_PRIVS: PrivDef[] = [
  { key: "SELECT", label: "Read", hint: "SELECT" },
  { key: "INSERT", label: "Insert", hint: "INSERT" },
  { key: "UPDATE", label: "Update", hint: "UPDATE" },
  { key: "DELETE", label: "Delete", hint: "DELETE" },
];


export interface PrivDef {
  key: string;
  label: string;
  hint: string;
}

export interface PrivGroup {
  title: string;
  privs: PrivDef[];
}

const d = (key: string, hint: string, label = key): PrivDef => ({ key, label, hint });

export const MY_DB_GROUPS: PrivGroup[] = [
  {
    title: "Data",
    privs: [d("SELECT", "Read rows"), d("INSERT", "Add rows"), d("UPDATE", "Change rows"), d("DELETE", "Delete rows")],
  },
  {
    title: "Structure",
    privs: [
      d("CREATE", "Create tables and databases"),
      d("ALTER", "Change table structure"),
      d("DROP", "Drop tables and databases"),
      d("INDEX", "Create and drop indexes"),
      d("REFERENCES", "Create foreign keys"),
      d("CREATE VIEW", "Create views"),
      d("SHOW VIEW", "See view definitions"),
      d("TRIGGER", "Create and drop triggers"),
      d("CREATE TEMPORARY TABLES", "Use temporary tables", "TEMP TABLES"),
      d("LOCK TABLES", "Lock tables (also needed by mysqldump)"),
    ],
  },
  {
    title: "Routines & events",
    privs: [
      d("EXECUTE", "Call procedures and functions"),
      d("CREATE ROUTINE", "Create procedures and functions"),
      d("ALTER ROUTINE", "Change or drop routines"),
      d("EVENT", "Scheduled events"),
    ],
  },
];

export const MY_GLOBAL_GROUP: PrivGroup = {
  title: "Server administration",
  privs: [
    d("SHOW DATABASES", "See all databases"),
    d("PROCESS", "See other users' queries"),
    d("RELOAD", "FLUSH commands"),
    d("CREATE USER", "Create and drop users"),
    d("FILE", "Read/write files on the server"),
    d("REPLICATION CLIENT", "Check replication status"),
    d("REPLICATION SLAVE", "Act as a replica"),
    d("SHUTDOWN", "Stop the server"),
    d("SUPER", "Many admin operations (legacy)"),
    d("CREATE ROLE", "Create roles"),
    d("DROP ROLE", "Drop roles"),
    d("CREATE TABLESPACE", "Manage tablespaces"),
  ],
};

export const GRANT_OPTION: PrivDef = d("GRANT OPTION", "Can give its own privileges to other users");

const MY_DB_ALL = MY_DB_GROUPS.flatMap((g) => g.privs.map((p) => p.key));
const MY_GLOBAL_ALL = [...MY_DB_ALL, ...MY_GLOBAL_GROUP.privs.map((p) => p.key)];

export const PG_DB_PRIVS: PrivDef[] = [d("CONNECT", "Connect to this database"), d("CREATE", "Create new schemas"), d("TEMPORARY", "Create temporary tables")];
export const PG_SCHEMA_PRIVS: PrivDef[] = [d("USAGE", "See objects in the schema (needed for everything else)"), d("CREATE", "Create tables and other objects")];
export const PG_TABLE_PRIVS: PrivDef[] = [
  d("SELECT", "Read rows"),
  d("INSERT", "Add rows"),
  d("UPDATE", "Change rows"),
  d("DELETE", "Delete rows"),
  d("TRUNCATE", "Empty tables"),
  d("REFERENCES", "Create foreign keys to them"),
  d("TRIGGER", "Create triggers"),
];
export const PG_SEQ_PRIVS: PrivDef[] = [d("USAGE", "nextval / currval (needed to insert into serial columns)"), d("SELECT", "Read the current value"), d("UPDATE", "setval")];

export type Preset = "none" | "read" | "write" | "full";
export const PRESETS: { key: Preset; label: string; hint: string }[] = [
  { key: "read", label: "Read only", hint: "Can read data, nothing else" },
  { key: "write", label: "Read & write", hint: "Read and change data, but not the structure" },
  { key: "full", label: "Full", hint: "Everything, including creating and dropping tables" },
  { key: "none", label: "None", hint: "Remove all privileges here" },
];

export function myPreset(p: Preset): string[] {
  switch (p) {
    case "read":
      return ["SELECT", "SHOW VIEW"];
    case "write":
      return ["SELECT", "SHOW VIEW", "INSERT", "UPDATE", "DELETE", "EXECUTE", "LOCK TABLES", "CREATE TEMPORARY TABLES"];
    case "full":
      return [...MY_DB_ALL];
    default:
      return [];
  }
}

/** PostgreSQL schema: [schema, table, sequence privileges] */
export function pgPreset(p: Preset): [string[], string[], string[]] {
  switch (p) {
    case "read":
      return [["USAGE"], ["SELECT"], ["SELECT"]];
    case "write":
      return [["USAGE"], ["SELECT", "INSERT", "UPDATE", "DELETE"], ["USAGE", "SELECT"]];
    case "full":
      return [["USAGE", "CREATE"], PG_TABLE_PRIVS.map((x) => x.key), PG_SEQ_PRIVS.map((x) => x.key)];
    default:
      return [[], [], []];
  }
}


async function rows(connId: string, sql: string): Promise<(string | null)[][]> {
  const out = await api.runQuery(connId, crypto.randomUUID(), sql, 100000);
  return out.resultSets.find((r) => r.returnsRows)?.rows ?? [];
}

const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
const pgLit = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const myIdent = (s: string) => `\`${s.replace(/`/g, "``")}\``;
export const myAccount = (user: string, host: string) => `${lit(user)}@${lit(host)}`;

export async function listAccounts(connId: string, kind: DbKind): Promise<Account[]> {
  if (kind === "mysql") {
    const r = await rows(connId, "SELECT user, host, plugin, account_locked FROM mysql.user ORDER BY user, host");
    return r.map(([user, host, plugin, locked]) => ({ kind: "mysql", user: user ?? "", host: host ?? "", plugin: plugin ?? "", locked: locked === "Y" }));
  }
  const r = await rows(
    connId,
    `SELECT r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolinherit, r.rolconnlimit,
            r.rolvaliduntil::text,
            COALESCE((SELECT string_agg(b.rolname, chr(1) ORDER BY b.rolname) FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid), '')
       FROM pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY 1`,
  );
  const t = (v: string | null) => v === "t" || v === "true";
  return r.map((x) => ({
    kind: "postgres",
    name: x[0] ?? "",
    login: t(x[1]),
    superuser: t(x[2]),
    createdb: t(x[3]),
    createrole: t(x[4]),
    replication: t(x[5]),
    bypassrls: t(x[6]),
    inherit: t(x[7]),
    connLimit: Number(x[8] ?? -1),
    validUntil: x[9] && x[9] !== "infinity" ? x[9] : null,
    memberOf: x[10] ? x[10].split("\u0001") : [],
  }));
}

/** MySQL: privileges from SHOW GRANTS. */
export async function loadMyPrivileges(connId: string, a: MyAccount): Promise<Privileges> {
  const p = emptyPrivileges();
  const r = await rows(connId, `SHOW GRANTS FOR ${myAccount(a.user, a.host)}`);
  for (const [line] of r) {
    if (!line) continue;
    p.raw.push(line);
    const m = /^GRANT (.+?) ON (\S+) TO .+?( WITH GRANT OPTION)?$/i.exec(line);
    if (!m) {
      if (!/^GRANT USAGE ON \*\.\*/i.test(line)) p.other.push(line);
      continue;
    }
    const [, privsText, object, withGrant] = m;
    let scope: string | null = null;
    if (object === "*.*") scope = "*";
    else {
      const db = /^`((?:[^`]|``)+)`\.\*$/.exec(object);
      if (db) scope = db[1].replace(/``/g, "`").replace(/\\_/g, "_").replace(/\\%/g, "%");
      // `db`.`table` (no column privileges)
      const tbl = /^`((?:[^`]|``)+)`\.`((?:[^`]|``)+)`$/.exec(object);
      if (tbl && !/\(/.test(privsText)) {
        const key = objKey(tbl[1].replace(/``/g, "`"), tbl[2].replace(/``/g, "`"));
        const set = new Set(p.objectGrants[key] ?? []);
        for (const x of privsText.split(/,\s*/).map((s) => s.trim().toUpperCase())) {
          if (x === "ALL" || x === "ALL PRIVILEGES") OBJECT_PRIVS.forEach((o) => set.add(o.key));
          else if (x !== "USAGE") set.add(x);
        }
        p.objectGrants[key] = [...set];
        // privileges not offered per object (e.g. ALTER on one table) are kept as "other"
        if ([...set].some((x) => !OBJECT_PRIVS.some((o) => o.key === x)) || withGrant) p.other.push(line);
        continue;
      }
    }
    // column grants are read-only
    if (scope === null || /\(/.test(privsText)) {
      p.other.push(line);
      continue;
    }
    const list = privsText.split(/,\s*/).map((s) => s.trim().toUpperCase());
    const set = new Set(p.granted[scope] ?? []);
    for (const x of list) {
      if (x === "ALL" || x === "ALL PRIVILEGES") (scope === "*" ? MY_GLOBAL_ALL : MY_DB_ALL).forEach((k) => set.add(k));
      else if (x !== "USAGE") set.add(x);
    }
    if (withGrant) set.add("GRANT OPTION");
    p.granted[scope] = [...set];
  }
  return p;
}

/** PostgreSQL: explicit grants (ACL) in the current database, plus owned objects. */
export async function loadPgPrivileges(connId: string, role: string): Promise<Privileges> {
  const p = emptyPrivileges();
  const r = pgLit(role);
  const oid = `(SELECT oid FROM pg_roles WHERE rolname = ${r})`;
  const userSchemas = `n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'`;
  const [dbRows, schemaRows, ownedRows, objRows, totalRows, defRows, perObj, ownedObjs] = await Promise.all([
    rows(connId, `SELECT a.privilege_type FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = current_database() AND a.grantee = ${oid}`),
    rows(connId, `SELECT n.nspname, a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a WHERE ${userSchemas} AND a.grantee = ${oid}`),
    rows(connId, `SELECT n.nspname FROM pg_namespace n WHERE ${userSchemas} AND n.nspowner = ${oid}`),
    rows(
      connId,
      `SELECT n.nspname, CASE WHEN c.relkind = 'S' THEN 'sequences' ELSE 'tables' END, a.privilege_type, count(DISTINCT c.oid)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
        WHERE ${userSchemas} AND c.relkind IN ('r','p','v','m','f','S') AND a.grantee = ${oid} AND c.relowner <> ${oid}
        GROUP BY 1, 2, 3`,
    ),
    rows(
      connId,
      `SELECT n.nspname, CASE WHEN c.relkind = 'S' THEN 'sequences' ELSE 'tables' END, count(*), count(*) FILTER (WHERE c.relowner = ${oid})
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE ${userSchemas} AND c.relkind IN ('r','p','v','m','f','S')
        GROUP BY 1, 2`,
    ),
    rows(
      connId,
      `SELECT DISTINCT n.nspname FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
        WHERE d.defaclobjtype = 'r' AND a.grantee = ${oid}`,
    ),
    rows(
      connId,
      `SELECT n.nspname, c.relname, a.privilege_type
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
        WHERE ${userSchemas} AND c.relkind IN ('r','p','v','m','f') AND a.grantee = ${oid} AND c.relowner <> ${oid}`,
    ),
    rows(
      connId,
      `SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE ${userSchemas} AND c.relkind IN ('r','p','v','m','f') AND c.relowner = ${oid}`,
    ),
  ]);
  for (const [s, t, priv] of perObj) (p.objectGrants[objKey(s ?? "", t ?? "")] ??= []).push(priv ?? "");
  p.ownedObjects = ownedObjs.map(([s, t]) => objKey(s ?? "", t ?? ""));
  p.granted.db = dbRows.map((x) => x[0] ?? "");
  for (const [s, priv] of schemaRows) (p.granted[`schema:${s}`] ??= []).push(priv ?? "");
  p.ownedSchemas = ownedRows.map((x) => x[0] ?? "");
  for (const [s, kind, total, owned] of totalRows) p.objects[`${kind}:${s}`] = { total: Number(total), owned: Number(owned), counts: {} };
  for (const [s, kind, priv, n] of objRows) {
    const o = (p.objects[`${kind}:${s}`] ??= { total: 0, owned: 0, counts: {} });
    o.counts[priv ?? ""] = Number(n);
  }
  p.futureTables = defRows.map((x) => x[0] ?? "");
  return p;
}

/** Updatable views by objKey; views with GROUP BY, DISTINCT, aggregates, UNION etc. are read-only. */
export async function loadViewWritability(connId: string, kind: DbKind): Promise<Record<string, boolean>> {
  const sql =
    kind === "mysql"
      ? `SELECT table_schema, table_name, is_updatable = 'YES' FROM information_schema.views
          WHERE table_schema NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema')`
      : `SELECT table_schema, table_name,
                (is_updatable = 'YES' OR is_insertable_into = 'YES' OR is_trigger_updatable = 'YES' OR is_trigger_insertable_into = 'YES' OR is_trigger_deletable = 'YES')
           FROM information_schema.views WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`;
  const r = await rows(connId, sql);
  return Object.fromEntries(r.map(([s, v, w]) => [objKey(s ?? "", v ?? ""), w === "1" || w === "t" || w === "true"]));
}

/** PostgreSQL: table and sequence counts per schema (for a new role). */
export async function loadPgTotals(connId: string): Promise<Privileges["objects"]> {
  const r = await rows(
    connId,
    `SELECT n.nspname, CASE WHEN c.relkind = 'S' THEN 'sequences' ELSE 'tables' END, count(*)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f','S')
      GROUP BY 1, 2`,
  );
  return Object.fromEntries(r.map(([s, kind, total]) => [`${kind}:${s}`, { total: Number(total), owned: 0, counts: {} }]));
}

/** Privilege state across all tables/sequences of a schema. */
export function objectState(o: PgObjectPrivs | undefined, priv: string): "all" | "some" | "none" | "empty" {
  if (!o || o.total === 0) return "empty";
  const n = (o.counts[priv] ?? 0) + o.owned;
  return n >= o.total ? "all" : n > 0 ? "some" : "none";
}


export interface Draft {
  account: Account;
  /** Empty = unchanged */
  password: string;
  privileges: Privileges;
  /** PostgreSQL: desired "all tables/sequences" state, "tables:s" -> privileges */
  objectTargets: Record<string, string[]>;
}

/** Statement plus a display version with the password masked. */
export interface Stmt {
  sql: string;
  display: string;
}

const plain = (sql: string): Stmt => ({ sql, display: sql });

export function buildSql(kind: DbKind, original: Draft | null, draft: Draft): Stmt[] {
  return kind === "mysql" ? buildMy(original, draft) : buildPg(original, draft);
}

function buildMy(original: Draft | null, draft: Draft): Stmt[] {
  const out: Stmt[] = [];
  const a = draft.account as MyAccount;
  const o = original?.account as MyAccount | undefined;
  const acc = myAccount(a.user, a.host);
  if (!o || a.isNew) {
    const pw = draft.password ? ` IDENTIFIED BY ${lit(draft.password)}` : "";
    const pwShown = draft.password ? " IDENTIFIED BY '••••••'" : "";
    const lock = a.locked ? " ACCOUNT LOCK" : "";
    out.push({ sql: `CREATE USER ${acc}${pw}${lock}`, display: `CREATE USER ${acc}${pwShown}${lock}` });
  } else {
    if (o.user !== a.user || o.host !== a.host) out.push(plain(`RENAME USER ${myAccount(o.user, o.host)} TO ${acc}`));
    if (draft.password) out.push({ sql: `ALTER USER ${acc} IDENTIFIED BY ${lit(draft.password)}`, display: `ALTER USER ${acc} IDENTIFIED BY '••••••'` });
    if (o.locked !== a.locked) out.push(plain(`ALTER USER ${acc} ACCOUNT ${a.locked ? "LOCK" : "UNLOCK"}`));
  }
  const before = original?.privileges.granted ?? {};
  const after = draft.privileges.granted;
  for (const scope of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const on = scope === "*" ? "*.*" : `${myIdent(scope)}.*`;
    const was = new Set(before[scope] ?? []);
    const now = new Set(after[scope] ?? []);
    const all = scope === "*" ? MY_GLOBAL_ALL : MY_DB_ALL;
    const add = [...now].filter((x) => !was.has(x) && x !== "GRANT OPTION");
    const del = [...was].filter((x) => !now.has(x) && x !== "GRANT OPTION");
    if (del.length) out.push(plain(`REVOKE ${del.join(", ")} ON ${on} FROM ${acc}`));
    if (add.length) {
      const full = all.every((x) => now.has(x)) && add.length > 1;
      out.push(plain(`GRANT ${full ? "ALL PRIVILEGES" : add.join(", ")} ON ${on} TO ${acc}`));
    }
    if (now.has("GRANT OPTION") && !was.has("GRANT OPTION")) out.push(plain(`GRANT GRANT OPTION ON ${on} TO ${acc}`));
    if (!now.has("GRANT OPTION") && was.has("GRANT OPTION")) out.push(plain(`REVOKE GRANT OPTION ON ${on} FROM ${acc}`));
  }
  const ob = original?.privileges.objectGrants ?? {};
  const oa = draft.privileges.objectGrants;
  for (const key of new Set([...Object.keys(ob), ...Object.keys(oa)])) {
    const [db, t] = splitObjKey(key);
    const on = `${myIdent(db)}.${myIdent(t)}`;
    const was = ob[key] ?? [];
    const now = oa[key] ?? [];
    const del = was.filter((x) => !now.includes(x));
    const add = now.filter((x) => !was.includes(x));
    if (del.length) out.push(plain(`REVOKE ${del.join(", ")} ON ${on} FROM ${acc}`));
    if (add.length) out.push(plain(`GRANT ${add.join(", ")} ON ${on} TO ${acc}`));
  }
  return out;
}

function pgAttrs(r: PgRole, o: PgRole | undefined): string[] {
  const flags: [keyof PgRole, string][] = [
    ["login", "LOGIN"],
    ["superuser", "SUPERUSER"],
    ["createdb", "CREATEDB"],
    ["createrole", "CREATEROLE"],
    ["replication", "REPLICATION"],
    ["bypassrls", "BYPASSRLS"],
    ["inherit", "INHERIT"],
  ];
  // New role: only what differs from the defaults (NOLOGIN, INHERIT, no limit)
  const base: PgRole = o ?? {
    name: "",
    login: false,
    superuser: false,
    createdb: false,
    createrole: false,
    replication: false,
    bypassrls: false,
    inherit: true,
    connLimit: -1,
    validUntil: null,
    memberOf: [],
  };
  const out: string[] = [];
  for (const [k, word] of flags) if (base[k] !== r[k]) out.push(r[k] ? word : `NO${word}`);
  if (base.connLimit !== r.connLimit) out.push(`CONNECTION LIMIT ${Number.isFinite(r.connLimit) ? r.connLimit : -1}`);
  if ((base.validUntil ?? "") !== (r.validUntil ?? "")) out.push(`VALID UNTIL ${pgLit(r.validUntil || "infinity")}`);
  return out;
}

function buildPg(original: Draft | null, draft: Draft): Stmt[] {
  const out: Stmt[] = [];
  const r = draft.account as PgRole;
  const o = original?.account as PgRole | undefined;
  const isNew = !o || r.isNew;
  let name = pgIdent(r.name);
  if (isNew) {
    const attrs = pgAttrs(r, undefined).join(" ");
    const w = attrs || draft.password ? " WITH" : "";
    const pw = draft.password ? ` PASSWORD ${pgLit(draft.password)}` : "";
    out.push({ sql: `CREATE ROLE ${name}${w} ${attrs}${pw}`.trimEnd(), display: `CREATE ROLE ${name}${w} ${attrs}${draft.password ? " PASSWORD '••••••'" : ""}`.trimEnd() });
  } else {
    if (o.name !== r.name) out.push(plain(`ALTER ROLE ${pgIdent(o.name)} RENAME TO ${name}`));
    const attrs = pgAttrs(r, o);
    if (attrs.length) out.push(plain(`ALTER ROLE ${name} WITH ${attrs.join(" ")}`));
    if (draft.password) out.push({ sql: `ALTER ROLE ${name} WITH PASSWORD ${pgLit(draft.password)}`, display: `ALTER ROLE ${name} WITH PASSWORD '••••••'` });
  }
  name = pgIdent(r.name);

  // memberships
  const wasIn = new Set(o?.memberOf ?? []);
  for (const g of r.memberOf) if (!wasIn.has(g)) out.push(plain(`GRANT ${pgIdent(g)} TO ${name}`));
  for (const g of wasIn) if (!r.memberOf.includes(g)) out.push(plain(`REVOKE ${pgIdent(g)} FROM ${name}`));

  const before = original?.privileges ?? emptyPrivileges();
  const after = draft.privileges;
  const diff = (was: string[], now: string[]) => [now.filter((x) => !was.includes(x)), was.filter((x) => !now.includes(x))];

  // database
  {
    const [add, del] = diff(before.granted.db ?? [], after.granted.db ?? []);
    if (del.length) out.push(plain(`REVOKE ${del.join(", ")} ON DATABASE ${pgIdent("__DB__")} FROM ${name}`));
    if (add.length) out.push(plain(`GRANT ${add.join(", ")} ON DATABASE ${pgIdent("__DB__")} TO ${name}`));
  }
  // schemas
  const schemas = new Set<string>();
  for (const k of [...Object.keys(before.granted), ...Object.keys(after.granted), ...Object.keys(draft.objectTargets)]) {
    const m = /^(?:schema|tables|sequences):(.*)$/.exec(k);
    if (m) schemas.add(m[1]);
  }
  for (const k of [...Object.keys(before.objectGrants), ...Object.keys(after.objectGrants)]) schemas.add(splitObjKey(k)[0]);
  for (const s of schemas) {
    const sch = pgIdent(s);
    const [add, del] = diff(before.granted[`schema:${s}`] ?? [], after.granted[`schema:${s}`] ?? []);
    if (add.length) out.push(plain(`GRANT ${add.join(", ")} ON SCHEMA ${sch} TO ${name}`));
    for (const kind of ["tables", "sequences"] as const) {
      const target = draft.objectTargets[`${kind}:${s}`];
      if (!target) continue;
      const objs = before.objects[`${kind}:${s}`];
      const word = kind === "tables" ? "TABLES" : "SEQUENCES";
      const privs = kind === "tables" ? PG_TABLE_PRIVS : PG_SEQ_PRIVS;
      const grant = privs.map((p) => p.key).filter((p) => target.includes(p) && objectState(objs, p) !== "all");
      const revoke = privs.map((p) => p.key).filter((p) => !target.includes(p) && ["all", "some"].includes(objectState(objs, p)));
      if (revoke.length) out.push(plain(`REVOKE ${revoke.join(", ")} ON ALL ${word} IN SCHEMA ${sch} FROM ${name}`));
      if (grant.length) out.push(plain(`GRANT ${grant.join(", ")} ON ALL ${word} IN SCHEMA ${sch} TO ${name}`));
      // for new tables/sequences created by the current user
      if (after.futureTables.includes(s)) {
        if (grant.length) out.push(plain(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${sch} GRANT ${grant.join(", ")} ON ${word} TO ${name}`));
        if (revoke.length) out.push(plain(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${sch} REVOKE ${revoke.join(", ")} ON ${word} FROM ${name}`));
      }
    }
    // Single objects go after "ALL TABLES" statements, which would override them
    const allTarget = draft.objectTargets[`tables:${s}`];
    const allObjs = before.objects[`tables:${s}`];
    const revokedAll = allTarget ? PG_TABLE_PRIVS.map((x) => x.key).filter((x) => !allTarget.includes(x) && ["all", "some"].includes(objectState(allObjs, x))) : [];
    const grantedAll = allTarget ?? currentObjectPrivs(allObjs, "tables");
    const keys = new Set([...Object.keys(before.objectGrants), ...Object.keys(after.objectGrants)].filter((k) => splitObjKey(k)[0] === s));
    for (const key of keys) {
      const on = `${sch}.${pgIdent(splitObjKey(key)[1])}`;
      // REVOKE ... ON ALL TABLES removed it from this object too
      const was = (before.objectGrants[key] ?? []).filter((x) => !revokedAll.includes(x));
      const now = (after.objectGrants[key] ?? []).filter((x) => !grantedAll.includes(x));
      const add = now.filter((x) => !was.includes(x));
      const rem = was.filter((x) => !now.includes(x) && !grantedAll.includes(x));
      if (rem.length) out.push(plain(`REVOKE ${rem.join(", ")} ON ${on} FROM ${name}`));
      if (add.length) out.push(plain(`GRANT ${add.join(", ")} ON ${on} TO ${name}`));
    }
    if (del.length) out.push(plain(`REVOKE ${del.join(", ")} ON SCHEMA ${sch} FROM ${name}`));
    // "future tables" turned on alone: copy the current grants into default privileges
    if (after.futureTables.includes(s) && !before.futureTables.includes(s)) {
      for (const kind of ["tables", "sequences"] as const) {
        const word = kind === "tables" ? "TABLES" : "SEQUENCES";
        const cur = draft.objectTargets[`${kind}:${s}`] ?? currentObjectPrivs(before.objects[`${kind}:${s}`], kind);
        const already = out.some((x) => x.sql.startsWith(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${sch} GRANT`) && x.sql.includes(` ON ${word} `));
        if (cur.length && !already) out.push(plain(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${sch} GRANT ${cur.join(", ")} ON ${word} TO ${name}`));
      }
    }
    if (!after.futureTables.includes(s) && before.futureTables.includes(s)) {
      out.push(plain(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${sch} REVOKE ALL ON TABLES FROM ${name}`));
      out.push(plain(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${sch} REVOKE ALL ON SEQUENCES FROM ${name}`));
    }
  }
  return out;
}

/** Privileges held on every object in the schema ("all" state). */
export function currentObjectPrivs(o: PgObjectPrivs | undefined, kind: "tables" | "sequences"): string[] {
  return (kind === "tables" ? PG_TABLE_PRIVS : PG_SEQ_PRIVS).map((p) => p.key).filter((p) => objectState(o, p) === "all");
}

export function dropSql(kind: DbKind, a: Account, reassignTo: string | null): Stmt[] {
  if (a.kind === "mysql") return [plain(`DROP USER ${myAccount(a.user, a.host)}`)];
  const n = pgIdent(a.name);
  const out: Stmt[] = [];
  if (reassignTo) {
    out.push(plain(`REASSIGN OWNED BY ${n} TO ${pgIdent(reassignTo)}`));
    out.push(plain(`DROP OWNED BY ${n}`));
  }
  out.push(plain(`DROP ROLE ${n}`));
  void kind;
  return out;
}

/** Postgres runs everything in one transaction; MySQL one by one (account changes auto-commit). */
export async function applyStatements(connId: string, kind: DbKind, stmts: Stmt[], database: string): Promise<void> {
  const sqls = stmts.map((s) => s.sql.replace(pgIdent("__DB__"), pgIdent(database)));
  if (kind === "postgres") {
    await api.executeBatch(connId, sqls);
    return;
  }
  for (let i = 0; i < sqls.length; i++) {
    try {
      await api.executeBatch(connId, [sqls[i]]);
    } catch (e) {
      const done = i > 0 ? ` The first ${i} statement${i > 1 ? "s were" : " was"} already applied.` : "";
      throw new Error(`Statement ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}.${done}`);
    }
  }
}
