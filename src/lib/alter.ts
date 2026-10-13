// Structure tab edits -> ALTER TABLE statements for MySQL / PostgreSQL.
import type { DbKind, StructColumn, StructForeignKey, TableStructure } from "./api";

export interface EditColumn {
  key: string;
  /** Column as it is in the database (undefined for a new column) */
  orig?: StructColumn;
  name: string;
  type: string;
  nullable: boolean;
  /** SQL expression; empty = no default */
  default: string;
  primaryKey: boolean;
  autoIncrement: boolean;
  comment: string;
  /** Empty = table/database default */
  collation: string;
  /** MySQL ON UPDATE expression, e.g. CURRENT_TIMESTAMP */
  onUpdate: string;
  deleted: boolean;
}

export interface NewIndex {
  key: string;
  name: string;
  columns: string[];
  unique: boolean;
}

export interface NewForeignKey {
  key: string;
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface StructureEdits {
  columns: EditColumn[];
  droppedIndexes: string[];
  newIndexes: NewIndex[];
  droppedForeignKeys: string[];
  newForeignKeys: NewForeignKey[];
}

export const FK_RULES = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];

/** Splits MySQL "extra" into the ON UPDATE expression and the rest (e.g. "VIRTUAL GENERATED"). */
export function splitExtra(extra: string | null): { onUpdate: string; rest: string } {
  if (!extra) return { onUpdate: "", rest: "" };
  const m = /on update\s+(.+)$/i.exec(extra);
  return { onUpdate: m ? m[1].trim() : "", rest: (m ? extra.slice(0, m.index) : extra).trim() };
}

export const isTextType = (t: string) => /char|text|enum|\bset\b|string/i.test(t);
export const isTimeType = (t: string) => /^(datetime|timestamp)/i.test(t.trim());

export function editableColumns(st: TableStructure): EditColumn[] {
  return st.columns.map((c, i) => ({
    key: `c${i}`,
    orig: c,
    name: c.name,
    type: c.columnType,
    nullable: c.nullable,
    default: c.default ?? "",
    primaryKey: c.primaryKey,
    autoIncrement: c.autoIncrement,
    comment: c.comment ?? "",
    collation: c.collation ?? "",
    onUpdate: splitExtra(c.extra).onUpdate,
    deleted: false,
  }));
}

export function emptyEdits(st: TableStructure): StructureEdits {
  return { columns: editableColumns(st), droppedIndexes: [], newIndexes: [], droppedForeignKeys: [], newForeignKeys: [] };
}

/** Changed fields of a column, for highlighting. */
export function changedFields(c: EditColumn): Set<keyof EditColumn> {
  const out = new Set<keyof EditColumn>();
  const o = c.orig;
  if (!o) return out;
  if (c.name !== o.name) out.add("name");
  if (c.type.trim() !== o.columnType) out.add("type");
  if (c.nullable !== o.nullable) out.add("nullable");
  if (c.default.trim() !== (o.default ?? "")) out.add("default");
  if (c.primaryKey !== o.primaryKey) out.add("primaryKey");
  if (c.autoIncrement !== o.autoIncrement) out.add("autoIncrement");
  if (c.comment !== (o.comment ?? "")) out.add("comment");
  if (c.collation.trim() !== (o.collation ?? "")) out.add("collation");
  if (c.onUpdate.trim() !== splitExtra(o.extra).onUpdate) out.add("onUpdate");
  return out;
}

export function countChanges(e: StructureEdits): number {
  let n = e.droppedIndexes.length + e.newIndexes.length + e.droppedForeignKeys.length + e.newForeignKeys.length;
  for (const c of e.columns) {
    if (c.deleted) n += c.orig ? 1 : 0;
    else if (!c.orig) n++;
    else if (changedFields(c).size > 0) n++;
  }
  return n;
}

const q = (kind: DbKind, name: string) => (kind === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`);
const lit = (kind: DbKind, s: string) => `'${(kind === "mysql" ? s.replace(/\\/g, "\\\\") : s).replace(/'/g, "''")}'`;
const list = (kind: DbKind, cols: string[]) => cols.map((c) => q(kind, c)).join(", ");

/** Empty list = no changes. */
export function buildAlter(kind: DbKind, st: TableStructure, e: StructureEdits): string[] {
  return kind === "mysql" ? mysqlAlter(st, e) : postgresAlter(st, e);
}

function pkChanged(st: TableStructure, e: StructureEdits) {
  const before = st.columns.filter((c) => c.primaryKey).map((c) => c.name);
  const after = e.columns.filter((c) => !c.deleted && c.primaryKey).map((c) => c.name);
  const renamed = e.columns.some((c) => c.orig?.primaryKey && c.name !== c.orig.name);
  return { changed: renamed || before.join(",") !== after.join(","), before, after };
}


function mysqlAlter(st: TableStructure, e: StructureEdits): string[] {
  const k: DbKind = "mysql";
  const table = `${q(k, st.schema)}.${q(k, st.table)}`;
  const out: string[] = [];

  if (e.droppedForeignKeys.length) {
    out.push(`ALTER TABLE ${table}\n  ${e.droppedForeignKeys.map((n) => `DROP FOREIGN KEY ${q(k, n)}`).join(",\n  ")};`);
  }

  const def = (c: EditColumn) => {
    let s = `${q(k, c.name)} ${c.type.trim()}`;
    if (c.collation.trim() && isTextType(c.type)) s += ` COLLATE ${c.collation.trim()}`;
    s += c.nullable ? " NULL" : " NOT NULL";
    if (c.default.trim()) s += ` DEFAULT ${c.default.trim()}`;
    if (c.autoIncrement) s += " AUTO_INCREMENT";
    if (c.onUpdate.trim()) s += ` ON UPDATE ${c.onUpdate.trim()}`;
    if (c.comment) s += ` COMMENT ${lit(k, c.comment)}`;
    return s;
  };

  const clauses: string[] = [];
  const pk = pkChanged(st, e);
  if (pk.changed && pk.before.length) clauses.push("DROP PRIMARY KEY");
  for (const name of e.droppedIndexes) clauses.push(`DROP INDEX ${q(k, name)}`);
  for (const c of e.columns) if (c.deleted && c.orig) clauses.push(`DROP COLUMN ${q(k, c.orig.name)}`);

  const live = e.columns.filter((c) => !c.deleted);
  live.forEach((c, i) => {
    const position = i === 0 ? " FIRST" : ` AFTER ${q(k, live[i - 1].name)}`;
    if (!c.orig) clauses.push(`ADD COLUMN ${def(c)}${position}`);
    else {
      const ch = changedFields(c);
      ch.delete("primaryKey");
      if (ch.size > 0) clauses.push(c.name !== c.orig.name ? `CHANGE COLUMN ${q(k, c.orig.name)} ${def(c)}` : `MODIFY COLUMN ${def(c)}`);
    }
  });

  if (pk.changed && pk.after.length) clauses.push(`ADD PRIMARY KEY (${list(k, pk.after)})`);
  for (const ix of e.newIndexes) clauses.push(`ADD ${ix.unique ? "UNIQUE " : ""}INDEX ${q(k, ix.name)} (${list(k, ix.columns)})`);

  if (clauses.length) out.push(`ALTER TABLE ${table}\n  ${clauses.join(",\n  ")};`);

  for (const fk of e.newForeignKeys) out.push(mysqlAddFk(table, fk));
  return out;
}

function mysqlAddFk(table: string, fk: NewForeignKey) {
  const k: DbKind = "mysql";
  return (
    `ALTER TABLE ${table}\n  ADD CONSTRAINT ${q(k, fk.name)} FOREIGN KEY (${list(k, fk.columns)})\n` +
    `  REFERENCES ${q(k, fk.refSchema)}.${q(k, fk.refTable)} (${list(k, fk.refColumns)})\n` +
    `  ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate};`
  );
}


function postgresAlter(st: TableStructure, e: StructureEdits): string[] {
  const k: DbKind = "postgres";
  const table = `${q(k, st.schema)}.${q(k, st.table)}`;
  const at = (clause: string) => `ALTER TABLE ${table} ${clause};`;
  const out: string[] = [];

  for (const n of e.droppedForeignKeys) out.push(at(`DROP CONSTRAINT ${q(k, n)}`));

  const pk = pkChanged(st, e);
  const pkIndex = st.indexes.find((i) => i.primary);
  if (pk.changed && pkIndex) out.push(at(`DROP CONSTRAINT ${q(k, pkIndex.name)}`));

  for (const name of e.droppedIndexes) {
    const ix = st.indexes.find((i) => i.name === name);
    out.push(ix?.constraint ? at(`DROP CONSTRAINT ${q(k, name)}`) : `DROP INDEX ${q(k, st.schema)}.${q(k, name)};`);
  }

  for (const c of e.columns) if (c.deleted && c.orig) out.push(at(`DROP COLUMN ${q(k, c.orig.name)}`));

  for (const c of e.columns) {
    if (c.deleted) continue;
    if (!c.orig) {
      let s = `ADD COLUMN ${q(k, c.name)} ${c.type.trim()}`;
      if (c.collation.trim()) s += ` COLLATE ${q(k, c.collation.trim())}`;
      if (c.autoIncrement) s += " GENERATED BY DEFAULT AS IDENTITY";
      if (c.default.trim()) s += ` DEFAULT ${c.default.trim()}`;
      if (!c.nullable) s += " NOT NULL";
      out.push(at(s));
      if (c.comment) out.push(`COMMENT ON COLUMN ${table}.${q(k, c.name)} IS ${lit(k, c.comment)};`);
      continue;
    }
    const ch = changedFields(c);
    const col = q(k, c.name);
    if (ch.has("name")) out.push(at(`RENAME COLUMN ${q(k, c.orig.name)} TO ${col}`));
    if (ch.has("type") || ch.has("collation")) {
      const coll = c.collation.trim() ? ` COLLATE ${q(k, c.collation.trim())}` : "";
      out.push(at(`ALTER COLUMN ${col} TYPE ${c.type.trim()}${coll} USING ${col}::${c.type.trim()}`));
    }
    if (ch.has("default")) out.push(at(c.default.trim() ? `ALTER COLUMN ${col} SET DEFAULT ${c.default.trim()}` : `ALTER COLUMN ${col} DROP DEFAULT`));
    if (ch.has("nullable")) out.push(at(`ALTER COLUMN ${col} ${c.nullable ? "DROP" : "SET"} NOT NULL`));
    if (ch.has("autoIncrement")) {
      if (c.autoIncrement) out.push(at(`ALTER COLUMN ${col} ADD GENERATED BY DEFAULT AS IDENTITY`));
      else if (c.orig.extra?.includes("IDENTITY")) out.push(at(`ALTER COLUMN ${col} DROP IDENTITY`));
      else if (!ch.has("default")) out.push(at(`ALTER COLUMN ${col} DROP DEFAULT`));
    }
    if (ch.has("comment")) out.push(`COMMENT ON COLUMN ${table}.${col} IS ${c.comment ? lit(k, c.comment) : "NULL"};`);
  }

  if (pk.changed && pk.after.length) out.push(at(`ADD PRIMARY KEY (${list(k, pk.after)})`));
  for (const ix of e.newIndexes) out.push(`CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${q(k, ix.name)} ON ${table} (${list(k, ix.columns)});`);
  for (const fk of e.newForeignKeys) {
    out.push(
      `ALTER TABLE ${table}\n  ADD CONSTRAINT ${q(k, fk.name)} FOREIGN KEY (${list(k, fk.columns)})\n` +
        `  REFERENCES ${q(k, fk.refSchema)}.${q(k, fk.refTable)} (${list(k, fk.refColumns)})\n` +
        `  ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate};`,
    );
  }
  return out;
}

export function fkLabel(fk: StructForeignKey) {
  return `${fk.refTable} (${fk.refColumns.join(", ")})`;
}

export const COMMON_TYPES: Record<DbKind, string[]> = {
  mysql: [
    "int", "bigint", "smallint", "tinyint", "tinyint(1)", "int unsigned", "bigint unsigned", "decimal(10,2)", "float", "double",
    "varchar(255)", "varchar(100)", "char(36)", "text", "mediumtext", "longtext", "json",
    "date", "datetime", "timestamp", "time", "year", "blob", "enum('a','b')", "boolean",
  ],
  postgres: [
    "integer", "bigint", "smallint", "serial", "bigserial", "numeric(10,2)", "real", "double precision", "boolean",
    "character varying(255)", "varchar(100)", "char(10)", "text", "uuid", "json", "jsonb",
    "date", "timestamp without time zone", "timestamp with time zone", "time", "interval", "bytea", "inet", "text[]",
  ],
};
