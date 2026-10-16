// Grid filters: chips + manual WHERE re-run in the database on top of the last query.
import type { DbKind } from "./api";
import type { CellKind, TsUnit } from "./cellKind";
import { formatEpoch, looksNumeric } from "./cellKind";
import { exportableQuery, sortedQuery, type SortKey } from "./export";
import { quoteIdent } from "./sql";

// Column names that must be quoted in a WHERE (quoteIdent only looks at the characters)
const RESERVED = new Set(
  ("all and any array as asc between both case cast check collate column constraint create cross current_date current_time current_timestamp current_user " +
    "default delete desc distinct div do drop else end except exists false fetch for foreign from full grant group having if in index inner insert interval " +
    "into is join key keys leading left like limit lock match mod natural not null offset on only option or order outer primary range rank read references " +
    "regexp replace right row rows select set show some table then to trailing true union unique update usage use user using values when where window with xor")
    .split(" "),
);
export const ident = (name: string, kind: DbKind) => {
  if (!RESERVED.has(name)) return quoteIdent(name, kind);
  return kind === "mysql" ? `\`${name}\`` : `"${name}"`;
};

export type FilterOp =
  | "eq"
  | "ne"
  | "gt"
  | "ge"
  | "lt"
  | "le"
  | "between"
  | "contains"
  | "starts"
  | "in"
  | "null"
  | "notnull"
  | "empty"
  | "true"
  | "false"
  | "range";

export type DateRange = "today" | "yesterday" | "7d" | "30d" | "month";

export const RANGE_LABELS: Record<DateRange, string> = {
  today: "today",
  yesterday: "yesterday",
  "7d": "last 7 days",
  "30d": "last 30 days",
  month: "this month",
};

export interface ColumnFilter {
  id: string;
  /** Result column name */
  col: string;
  /** Table column behind it, when known (lets the WHERE go into a single-table query) */
  origin?: string;
  kind: CellKind;
  typeName: string;
  /** Integer column holding Unix timestamps */
  ts?: TsUnit | null;
  op: FilterOp;
  value?: string;
  value2?: string;
  values?: string[];
  range?: DateRange;
}

export interface GridFilters {
  /** Query the filters are applied to (what the editor ran) */
  base: string;
  items: ColumnFilter[];
  join: "and" | "or";
  /** Manual WHERE condition, raw SQL */
  where: string;
}

export const filtersActive = (f: GridFilters | undefined | null): f is GridFilters => !!f && (f.items.length > 0 || f.where.trim() !== "");

export const OP_LABEL: Record<FilterOp, string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  ge: "≥",
  lt: "<",
  le: "≤",
  between: "between",
  contains: "contains",
  starts: "starts with",
  in: "in",
  null: "is null",
  notnull: "is not null",
  empty: "is empty",
  true: "is true",
  false: "is false",
  range: "in range",
};

/** Operators offered for a column kind. */
export function opsFor(kind: CellKind, ts?: TsUnit | null): FilterOp[] {
  if (ts) return ["gt", "lt", "between", "eq", "null", "notnull"];
  switch (kind) {
    case "bool":
      return ["true", "false", "null", "notnull"];
    case "number":
    case "year":
      return ["eq", "ne", "gt", "ge", "lt", "le", "between", "in", "null", "notnull"];
    case "date":
    case "datetime":
    case "time":
      return ["eq", "gt", "ge", "lt", "le", "between", "null", "notnull"];
    case "enum":
    case "uuid":
      return ["eq", "ne", "in", "null", "notnull"];
    case "set":
      return ["eq", "ne", "contains", "null", "notnull"];
    case "json":
      return ["contains", "null", "notnull"];
    case "binary":
      return ["null", "notnull"];
    default:
      return ["contains", "starts", "eq", "ne", "in", "null", "notnull", "empty"];
  }
}

export const needsValue = (op: FilterOp) => !["null", "notnull", "empty", "true", "false", "range"].includes(op);

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** [from, to) local dates of a quick range. */
export function rangeBounds(r: DateRange, now = new Date()): [Date, Date] {
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  switch (r) {
    case "today":
      return [day(0), day(1)];
    case "yesterday":
      return [day(-1), day(0)];
    case "7d":
      return [day(-6), day(1)];
    case "30d":
      return [day(-29), day(1)];
    case "month":
      return [new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1)];
  }
}

const epochOf = (d: Date, unit: TsUnit) => String(unit === "s" ? Math.floor(d.getTime() / 1000) : d.getTime());

/** Quoted string literal (MySQL also escapes backslashes). */
export function strLit(kind: DbKind, v: string) {
  const body = kind === "mysql" ? v.replace(/\\/g, "\\\\") : v;
  return `'${body.replace(/'/g, "''")}'`;
}

const likeEsc = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Typed literal: numbers stay bare only when they really are numbers. */
function valueLit(kind: DbKind, f: ColumnFilter, v: string) {
  if ((f.kind === "number" || f.kind === "year" || f.ts) && looksNumeric(v)) return v.trim();
  return strLit(kind, v);
}

/** Postgres types shown as text that have no text operators (xml, inet, arrays, geometry…): compared as text. */
export const pgAsText = (kind: DbKind, c: { kind: CellKind; typeName: string }) =>
  kind === "postgres" && (c.kind === "json" || (c.kind === "text" && !/^(text|varchar|character varying|character|char|bpchar|name|citext)(\(\d+\))?$/i.test(c.typeName)));

/** One chip as SQL; `ref` is the quoted column reference. */
export function filterSql(kind: DbKind, f: ColumnFilter, ref0: string): string {
  const lit = (v: string | undefined) => valueLit(kind, f, v ?? "");
  const ref = pgAsText(kind, f) ? `${ref0}::text` : ref0;
  // LIKE on other non-text Postgres columns (numbers, dates, enums) needs a cast too
  const textRef = kind === "postgres" && f.kind !== "text" && !pgAsText(kind, f) ? `${ref}::text` : ref;
  const like = kind === "postgres" ? "ILIKE" : "LIKE";
  switch (f.op) {
    case "eq":
      return `${ref} = ${lit(f.value)}`;
    case "ne":
      return `${ref} <> ${lit(f.value)}`;
    case "gt":
      return `${ref} > ${lit(f.value)}`;
    case "ge":
      return `${ref} >= ${lit(f.value)}`;
    case "lt":
      return `${ref} < ${lit(f.value)}`;
    case "le":
      return `${ref} <= ${lit(f.value)}`;
    case "between":
      return `${ref} BETWEEN ${lit(f.value)} AND ${lit(f.value2)}`;
    case "contains":
      return `${textRef} ${like} ${strLit(kind, `%${likeEsc(f.value ?? "")}%`)}`;
    case "starts":
      return `${textRef} ${like} ${strLit(kind, `${likeEsc(f.value ?? "")}%`)}`;
    case "in": {
      const vals = f.values?.length ? f.values : [f.value ?? ""];
      return `${ref} IN (${vals.map(lit).join(", ")})`;
    }
    case "null":
      return `${ref} IS NULL`;
    case "notnull":
      return `${ref} IS NOT NULL`;
    case "empty":
      return `${ref} = ''`;
    case "true":
      return `${ref} IS TRUE`;
    case "false":
      return `${ref} IS FALSE`;
    case "range": {
      const [from, to] = rangeBounds(f.range ?? "today");
      const [a, b] = f.ts ? [epochOf(from, f.ts), epochOf(to, f.ts)] : [strLit(kind, ymd(from)), strLit(kind, ymd(to))];
      return `${ref} >= ${a} AND ${ref} < ${b}`;
    }
  }
}

/** Value as shown on a chip (Unix timestamps as dates). */
export function shownValue(f: ColumnFilter, v: string | undefined) {
  if (v === undefined) return "";
  if (f.ts && /^\d+$/.test(v)) return formatEpoch(Number(v) * (f.ts === "s" ? 1000 : 1));
  if (f.kind === "number" || f.kind === "year") return v;
  return `"${v.length > 40 ? `${v.slice(0, 40)}…` : v}"`;
}

/** "entity_id = 56", "via_qr_code is false", "created_at: last 7 days". */
export function filterLabel(f: ColumnFilter): string {
  switch (f.op) {
    case "null":
    case "notnull":
    case "empty":
    case "true":
    case "false":
      return `${f.col} ${OP_LABEL[f.op]}`;
    case "range":
      return `${f.col}: ${RANGE_LABELS[f.range ?? "today"]}`;
    case "between":
      return `${f.col} between ${shownValue(f, f.value)} and ${shownValue(f, f.value2)}`;
    case "in": {
      const vals = f.values ?? [];
      const shown = vals.slice(0, 3).map((v) => shownValue(f, v));
      return `${f.col} in (${shown.join(", ")}${vals.length > 3 ? `, +${vals.length - 3}` : ""})`;
    }
    default:
      return `${f.col} ${OP_LABEL[f.op]} ${shownValue(f, f.value)}`;
  }
}

// ---- query rewriting

interface Token {
  word: string;
  start: number;
  end: number;
}

/** Words and commas outside parentheses, strings and comments. */
function topLevel(sql: string, kind: DbKind): Token[] {
  const mysql = kind === "mysql";
  const out: Token[] = [];
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if ((c === "-" && next === "-") || (c === "#" && mysql)) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (c === "/" && next === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e === -1 ? sql.length : e + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && mysql) i += 2;
        else if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) break;
        else i++;
      }
      i++;
    } else if (c === "$" && !mysql && /^\$[A-Za-z_]*\$/.test(sql.slice(i, i + 64))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0];
      const e = sql.indexOf(tag, i + tag.length);
      i = e === -1 ? sql.length : e + tag.length;
    } else if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      depth--;
      i++;
    } else if (/[A-Za-z_]/.test(c) && !/[\w$]/.test(sql[i - 1] ?? "")) {
      let j = i;
      while (j < sql.length && /[\w$]/.test(sql[j])) j++;
      if (depth === 0) out.push({ word: sql.slice(i, j).toLowerCase(), start: i, end: j });
      i = j;
    } else {
      if (c === "," && depth === 0) out.push({ word: ",", start: i, end: i + 1 });
      i++;
    }
  }
  return out;
}

const IDENT = String.raw`(?:[A-Za-z_][\w$]*|"(?:[^"]|"")+"|\`(?:[^\`]|\`\`)+\`)`;
const SIMPLE_FROM = new RegExp(String.raw`^\s*${IDENT}(?:\s*\.\s*${IDENT}){0,2}(?:\s+(?:as\s+)?${IDENT})?\s*$`, "i");
const NOT_SIMPLE = new Set(["join", "group", "having", "union", "intersect", "except", "window", "for", "lateral", "into", "limit", "offset", "fetch", "qualify", "lock"]);

/** `SELECT … FROM one_table [WHERE …] [ORDER BY …]` split into parts, or null. */
function simpleParts(body: string, kind: DbKind) {
  const toks = topLevel(body, kind);
  if (toks[0]?.word !== "select") return null;
  if (toks.some((t) => NOT_SIMPLE.has(t.word))) return null;
  const froms = toks.filter((t) => t.word === "from");
  const wheres = toks.filter((t) => t.word === "where");
  const orderAt = toks.findIndex((t, i) => t.word === "order" && toks[i + 1]?.word === "by");
  if (froms.length !== 1 || wheres.length > 1) return null;
  const from = froms[0];
  const where = wheres[0];
  const order = orderAt >= 0 ? toks[orderAt] : undefined;
  if (where && (where.start < from.start || (order && order.start < where.start))) return null;
  if (order && order.start < from.start) return null;
  const fromEnd = where?.start ?? order?.start ?? body.length;
  if (!SIMPLE_FROM.test(body.slice(from.end, fromEnd))) return null;
  return {
    head: body.slice(0, fromEnd).trimEnd(),
    where: where ? body.slice(where.end, order?.start ?? body.length).trim() : "",
    order: order ? body.slice(order.start).trim() : "",
  };
}

/** Trailing ORDER BY that can move outside a wrapping SELECT (names of result columns or positions). */
function movableOrder(body: string, kind: DbKind, columns: string[]) {
  const toks = topLevel(body, kind);
  let at = -1;
  toks.forEach((t, i) => t.word === "order" && toks[i + 1]?.word === "by" && (at = i));
  if (at < 0) return null;
  const start = toks[at].start;
  const listStart = toks[at + 1].end;
  const text = body.slice(listStart);
  if (!text.trim()) return null;
  const items: string[] = [];
  let prev = 0;
  for (const t of toks.slice(at + 2)) {
    if (t.word !== ",") continue;
    items.push(text.slice(prev, t.start - listStart).trim());
    prev = t.end - listStart;
  }
  items.push(text.slice(prev).trim());
  const out: string[] = [];
  const item = new RegExp(String.raw`^(?:${IDENT}\s*\.\s*)?(${IDENT}|\d+)(\s+(?:asc|desc))?(\s+nulls\s+(?:first|last))?$`, "i");
  for (const it of items) {
    const m = item.exec(it);
    if (!m) return null;
    const raw = m[1];
    if (/^\d+$/.test(raw)) {
      out.push(it.slice(it.indexOf(raw)));
      continue;
    }
    const quoted = /^["`]/.test(raw);
    const name = quoted ? raw.slice(1, -1).replace(/""|``/g, (q) => q[0]) : raw;
    const col = columns.find((c) => (quoted || kind === "mysql" ? c === name || (kind === "mysql" && c.toLowerCase() === name.toLowerCase()) : c === name.toLowerCase()));
    if (!col) return null;
    out.push(`${ident(col, kind)}${m[2] ?? ""}${m[3] ?? ""}`);
  }
  return { inner: body.slice(0, start).trimEnd(), order: `ORDER BY ${out.join(", ")}` };
}

/** WHERE condition of the chips and the manual text; null when empty. */
export function filterCondition(kind: DbKind, f: GridFilters, inject: boolean): string | null {
  const parts = f.items.map((it) => filterSql(kind, it, ident(inject && it.origin ? it.origin : it.col, kind)));
  const chips = parts.length === 0 ? "" : parts.length === 1 ? parts[0] : f.join === "or" ? `(${parts.join(" OR ")})` : parts.join(" AND ");
  const manual = f.where.trim();
  if (!chips && !manual) return null;
  if (!manual) return chips;
  if (!chips) return /\bor\b/i.test(manual) ? `(${manual})` : manual;
  return `${chips} AND (${manual})`;
}

/** Whether filters can go straight into the query's WHERE (keeps the result editable). */
export function canInject(kind: DbKind, base: string, f: GridFilters) {
  const q = exportableQuery(base, kind);
  if (!q) return false;
  return !!simpleParts(q.unlimited ?? q.sql, kind) && f.items.every((it) => !!it.origin);
}

/**
 * The base query with the filters: added to the WHERE of a single-table SELECT, otherwise
 * wrapped as `SELECT * FROM (base) AS _f WHERE …`. The LIMIT stays last so the whole table is searched.
 */
export function filteredQuery(base: string, kind: DbKind, f: GridFilters, columns: string[]): string | null {
  const q = exportableQuery(base, kind);
  if (!q) return null;
  const body = q.unlimited ?? q.sql;
  const limit = q.limit ? `\n${q.limit}` : "";
  const inject = canInject(kind, base, f);
  const cond = filterCondition(kind, f, inject);
  if (!cond) return q.sql;
  if (inject) {
    const p = simpleParts(body, kind)!;
    const where = p.where ? `(${p.where}) AND ${cond}` : cond;
    return `${p.head}\nWHERE ${where}${p.order ? `\n${p.order}` : ""}${limit}`;
  }
  const moved = movableOrder(body, kind, columns);
  const inner = moved?.inner ?? body;
  return `SELECT *\nFROM (\n${inner}\n) AS _f\nWHERE ${cond}${moved ? `\n${moved.order}` : ""}${limit}`;
}

/** Filters then database sort, as one statement; null if the base can't be re-run. */
export function viewQuery(base: string, kind: DbKind, f: GridFilters | undefined, sort: SortKey[], columns: string[]): string | null {
  const filtered = filtersActive(f) ? filteredQuery(base, kind, f, columns) : (exportableQuery(base, kind)?.sql ?? null);
  if (!filtered) return null;
  return sort.length ? sortedQuery(filtered, kind, sort) : filtered;
}

/** Most common values of a column over the base query (without its LIMIT). */
export function topValuesQuery(base: string, kind: DbKind, col: string, asText = false): string | null {
  const q = exportableQuery(base, kind);
  if (!q) return null;
  const c = `_v.${ident(col, kind)}${asText ? "::text" : ""}`;
  return `SELECT ${c}, count(*) AS n\nFROM (\n${q.unlimited ?? q.sql}\n) AS _v\nGROUP BY ${c}\nORDER BY 2 DESC\nLIMIT 10`;
}

/** Same statement, ignoring whitespace and a trailing semicolon. */
export const sameSql = (a: string, b: string) => {
  const n = (s: string) => s.trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
  return n(a) === n(b);
};
