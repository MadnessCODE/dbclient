// Results grid edits -> UPDATE / INSERT / DELETE statements.
import type { Cell, DbKind, ResultSet, StructColumn, TableStructure } from "./api";
import { cellKind, isTruthy, looksNumeric } from "./cellKind";
import { quoteIdent } from "./sql";

/** Row key: "e<index in rs.rows>" for existing rows, "n<counter>" for new ones. */
export type RowKey = string;

export interface PendingEdits {
  /** Changed values of existing rows: rowKey -> (column -> value) */
  changed: Record<RowKey, Record<number, Cell>>;
  /** New rows; `undefined` means DEFAULT (the column is left out of the INSERT) */
  added: { key: RowKey; values: (Cell | undefined)[] }[];
  deleted: RowKey[];
}

export const emptyPending = (): PendingEdits => ({ changed: {}, added: [], deleted: [] });

export function pendingCount(p: PendingEdits) {
  return { updated: Object.keys(p.changed).filter((k) => !p.deleted.includes(k)).length, added: p.added.length, deleted: p.deleted.length };
}

export interface EditTarget {
  kind: DbKind;
  table: TableStructure;
  /** Table column behind each result column (null for expressions or other tables) */
  colMap: (StructColumn | null)[];
  /** Result column indexes of the primary key */
  pkCols: number[];
}

/**
 * A result is editable when all columns with an origin come from one table and that table's
 * primary key is fully selected. Returns the reason otherwise.
 */
export function editTargetOf(kind: DbKind, rs: ResultSet, table: TableStructure | null): EditTarget | string {
  const origins = rs.columns.map((c) => c.origin).filter((o) => o !== null);
  if (origins.length === 0) return "Read-only: the result does not come from a table.";
  const t0 = origins[0]!;
  if (origins.some((o) => o!.schema !== t0.schema || o!.table !== t0.table)) return "Read-only: the result combines several tables (JOIN).";
  if (!table) return "Loading table info…";
  if (table.isView) return "Read-only: this is a view.";
  const pk = table.columns.filter((c) => c.primaryKey);
  if (pk.length === 0) return `Read-only: table ${table.table} has no primary key.`;
  const colMap = rs.columns.map((c) => (c.origin ? table.columns.find((tc) => tc.name === c.origin!.column) ?? null : null));
  const pkCols = pk.map((p) => colMap.findIndex((m) => m?.name === p.name));
  if (pkCols.some((i) => i < 0)) return `Read-only: include the primary key (${pk.map((p) => p.name).join(", ")}) in the SELECT to edit rows.`;
  return { kind, table, colMap, pkCols };
}

/** SQL literal for a cell value, according to the column type. */
export function literal(kind: DbKind, v: Cell, col: StructColumn | null, typeName: string): string {
  if (v === null) return "NULL";
  const k = cellKind(typeName, col);
  if (k === "bool") {
    const on = isTruthy(v);
    return kind === "postgres" ? (on ? "TRUE" : "FALSE") : on ? "1" : "0";
  }
  if (k === "number" && looksNumeric(v)) return v.trim();
  const body = kind === "mysql" ? v.replace(/\\/g, "\\\\") : v;
  return `'${body.replace(/'/g, "''")}'`;
}

/** Statements to save, in order: DELETE, UPDATE, INSERT. */
export function buildDml(target: EditTarget, rs: ResultSet, p: PendingEdits): string[] {
  const { kind, table, colMap, pkCols } = target;
  const full = `${quoteIdent(table.schema, kind)}.${quoteIdent(table.table, kind)}`;
  const q = (name: string) => quoteIdent(name, kind);
  const lit = (ci: number, v: Cell) => literal(kind, v, colMap[ci], rs.columns[ci].typeName);
  const rowOf = (key: RowKey) => rs.rows[Number(key.slice(1))];
  const where = (row: Cell[]) =>
    pkCols.map((ci) => (row[ci] === null ? `${q(colMap[ci]!.name)} IS NULL` : `${q(colMap[ci]!.name)} = ${lit(ci, row[ci])}`)).join(" AND ");

  const out: string[] = [];
  for (const key of p.deleted) out.push(`DELETE FROM ${full} WHERE ${where(rowOf(key))};`);

  for (const [key, cols] of Object.entries(p.changed)) {
    if (p.deleted.includes(key)) continue;
    const orig = rowOf(key);
    const sets = Object.entries(cols)
      .map(([ci, v]) => [Number(ci), v] as const)
      .filter(([ci, v]) => colMap[ci] && v !== orig[ci])
      .map(([ci, v]) => `${q(colMap[ci]!.name)} = ${lit(ci, v)}`);
    if (sets.length) out.push(`UPDATE ${full} SET ${sets.join(", ")} WHERE ${where(orig)};`);
  }

  for (const row of p.added) {
    const cols: string[] = [];
    const vals: string[] = [];
    row.values.forEach((v, ci) => {
      if (v === undefined || !colMap[ci]) return;
      cols.push(q(colMap[ci]!.name));
      vals.push(lit(ci, v));
    });
    if (cols.length === 0) out.push(kind === "postgres" ? `INSERT INTO ${full} DEFAULT VALUES;` : `INSERT INTO ${full} () VALUES ();`);
    else out.push(`INSERT INTO ${full} (${cols.join(", ")}) VALUES (${vals.join(", ")});`);
  }
  return out;
}
