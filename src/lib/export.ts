// Result export: formats, options, writing to a file or the clipboard.
import { save } from "@tauri-apps/plugin-dialog";
import { api, type Cell, type DbKind, type ResultSet } from "./api";
import { cellKind, isTruthy, looksNumeric } from "./cellKind";
import { literal } from "./edit";
import { quoteIdent, splitStatements } from "./sql";

export type ExportFormat = "csv" | "excel" | "json" | "sql";

export interface ExportOptions {
  format: ExportFormat;
  /** Exported rs.columns indexes, in output order */
  columns: number[];
  header: boolean;
  // CSV
  delimiter: string;
  quoteAll: boolean;
  nullAs: string;
  crlf: boolean;
  bom: boolean;
  // JSON
  jsonStyle: "array" | "lines";
  pretty: boolean;
  typed: boolean;
  // Excel
  sheet: string;
  // SQL
  table: string;
  rowsPerInsert: number;
}

export const FORMATS: { key: ExportFormat; label: string; ext: string; desc: string }[] = [
  { key: "csv", label: "CSV", ext: "csv", desc: "Comma separated, opens in Excel / Sheets" },
  { key: "excel", label: "Excel", ext: "xlsx", desc: "Real .xlsx with numbers, dates and filters" },
  { key: "json", label: "JSON", ext: "json", desc: "Array of objects or JSON Lines" },
  { key: "sql", label: "SQL INSERT", ext: "sql", desc: "INSERT statements to load elsewhere" },
];

export const defaultOptions = (rs: ResultSet, table: string): ExportOptions => ({
  format: "csv",
  columns: rs.columns.map((_, i) => i),
  header: true,
  delimiter: ",",
  quoteAll: false,
  nullAs: "",
  crlf: true,
  bom: false,
  jsonStyle: "array",
  pretty: true,
  typed: true,
  sheet: table.split(".").pop() || "Export",
  table,
  rowsPerInsert: 100,
});

const LIMIT_TAIL = [
  /\s+limit\s+(\d+|all)(\s*,\s*\d+)?(\s+offset\s+\d+)?\s*$/i,
  /\s+offset\s+\d+(\s+rows?)?\s+limit\s+\d+\s*$/i,
  /(\s+offset\s+\d+\s+rows?)?\s+fetch\s+(first|next)\s+\d+\s+rows?\s+only\s*$/i,
];

/** A single read-only statement that can be re-run to export all rows; `unlimited` drops a trailing LIMIT/OFFSET. */
export function exportableQuery(sql: string | undefined, kind: DbKind): { sql: string; unlimited: string | null; limit: string | null } | null {
  if (!sql) return null;
  const stmts = splitStatements(sql, kind);
  if (stmts.length !== 1) return null;
  const text = stmts[0].text.trim().replace(/;\s*$/, "");
  if (!/^\(?\s*(select|with|table|values)\b/i.test(text)) return null;
  // WITH may contain writes (WITH x AS (DELETE ...)); never re-run those
  if (/\b(insert|update|delete|merge)\b/i.test(text) && /^with\b/i.test(text)) return null;
  for (const re of LIMIT_TAIL) {
    const m = re.exec(text);
    if (m) return { sql: text, unlimited: text.slice(0, m.index), limit: m[0].trim() };
  }
  return { sql: text, unlimited: null, limit: null };
}

export interface SortKey {
  col: number;
  dir: "asc" | "desc";
}

/** The query sorted in the database (positional ORDER BY), keeping its LIMIT; wrapped when it already has an ORDER BY. */
export function sortedQuery(sql: string, kind: DbKind, keys: SortKey[]): string | null {
  const q = exportableQuery(sql, kind);
  if (!q) return null;
  if (!keys.length) return q.sql;
  const body = q.unlimited ?? q.sql;
  const by = keys.map((k) => `${k.col + 1} ${k.dir.toUpperCase()}`).join(", ");
  const limit = q.limit ? `\n${q.limit}` : "";
  return /\border\s+by\b/i.test(body) ? `SELECT *\nFROM (\n${body}\n) AS _sorted\nORDER BY ${by}${limit}` : `${body}\nORDER BY ${by}${limit}`;
}

/** Grid state per tab: sorted row order and selected rows (indexes into rs.rows). */
export const gridViews = new Map<string, { rs: ResultSet; order: number[]; selected: number[] }>();

export function render(kind: DbKind, rs: ResultSet, rows: Cell[][], o: ExportOptions): string {
  const cols = o.columns.map((i) => rs.columns[i]);
  const pick = (r: Cell[]) => o.columns.map((i) => r[i]);
  const nl = o.crlf ? "\r\n" : "\n";

  switch (o.format) {
    case "csv": {
      const d = o.delimiter;
      const esc = (v: Cell) => {
        if (v === null) return o.nullAs;
        const needs = o.quoteAll || v.includes(d) || /["\r\n]/.test(v);
        return needs ? `"${v.replace(/"/g, '""')}"` : v;
      };
      const lines = rows.map((r) => pick(r).map(esc).join(d));
      if (o.header) lines.unshift(cols.map((c) => esc(c.name)).join(d));
      return lines.join(nl);
    }
    case "json": {
      const kinds = cols.map((c) => cellKind(c.typeName));
      const val = (v: Cell, i: number) => {
        if (v === null || !o.typed) return v;
        if (kinds[i] === "number" && looksNumeric(v) && v.replace(/[^0-9]/g, "").replace(/^0+/, "").length <= 15) return Number(v);
        if (kinds[i] === "bool") return isTruthy(v);
        if (kinds[i] === "json") {
          try {
            return JSON.parse(v);
          } catch {
            return v;
          }
        }
        return v;
      };
      const objs = rows.map((r) => Object.fromEntries(pick(r).map((v, i) => [cols[i].name, val(v, i)])));
      if (o.jsonStyle === "lines") return objs.map((x) => JSON.stringify(x)).join("\n");
      return JSON.stringify(objs, null, o.pretty ? 2 : undefined);
    }
    case "sql": {
      const target = o.table
        .split(".")
        .map((p) => quoteIdent(p, kind))
        .join(".");
      const colList = cols.map((c) => quoteIdent(c.name, kind)).join(", ");
      const kinds = cols.map((c) => cellKind(c.typeName));
      const lit = (v: Cell, i: number) =>
        // MySQL binary values arrive as 0x… and stay unquoted
        kinds[i] === "binary" && kind === "mysql" && v !== null && /^0x[0-9a-f]*$/i.test(v) ? v : literal(kind, v, null, cols[i].typeName);
      const tuple = (r: Cell[]) => `(${pick(r).map(lit).join(", ")})`;
      const out: string[] = [];
      const n = Math.max(1, o.rowsPerInsert);
      for (let i = 0; i < rows.length; i += n) {
        const chunk = rows.slice(i, i + n).map(tuple);
        out.push(`INSERT INTO ${target} (${colList}) VALUES\n  ${chunk.join(",\n  ")};`);
      }
      return out.join("\n\n") + (out.length ? "\n" : "");
    }
    case "excel":
      // Excel files are written in Rust (exportXlsx); this is TSV for the clipboard
      return [...(o.header ? [cols.map((c) => c.name)] : []), ...rows.map((r) => pick(r).map((v) => v ?? o.nullAs))]
        .map((r) => r.map((v) => v.replace(/[\t\r\n]+/g, " ")).join("\t"))
        .join("\r\n");
  }
}

/** Save dialog; null if cancelled. */
export async function askPath(baseName: string, format: ExportFormat): Promise<string | null> {
  const f = FORMATS.find((x) => x.key === format)!;
  return save({
    defaultPath: `${baseName.replace(/\.sql$/, "")}.${f.ext}`,
    filters: [{ name: f.label, extensions: [f.ext] }],
  });
}

/** Writes the export; Excel goes through Rust for typed cells. */
export async function writeExport(path: string, kind: DbKind, rs: ResultSet, rows: Cell[][], o: ExportOptions): Promise<void> {
  if (o.format === "excel") {
    const columns = o.columns.map((i) => {
      const k = cellKind(rs.columns[i].typeName);
      return { name: rs.columns[i].name, kind: k === "number" || k === "bool" || k === "date" || k === "datetime" || k === "time" ? k : "text" };
    });
    await api.exportXlsx(
      path,
      columns,
      rows.map((r) => o.columns.map((i) => r[i])),
      { sheet: o.sheet, header: o.header, nullAs: o.nullAs },
    );
    return;
  }
  const text = render(kind, rs, rows, o);
  await api.writeTextFile(path, o.bom && o.format === "csv" ? "﻿" + text : text);
}
