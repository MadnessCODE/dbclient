// Cell kind (for display and editor choice), derived from the column type.
import type { StructColumn } from "./api";

export type CellKind =
  | "bool"
  | "number"
  | "date"
  | "datetime"
  | "time"
  | "year"
  | "json"
  | "enum"
  | "set"
  | "binary"
  | "uuid"
  | "text";

/** Uses the result type ("timestamptz", "json") and, when known, the table column type ("tinyint(1)", "enum('a','b')"). */
export function cellKind(typeName: string, col?: StructColumn | null): CellKind {
  const t = (col?.columnType ?? typeName).toLowerCase().trim();
  const r = typeName.toLowerCase();
  if (col?.enumValues?.length) return t.startsWith("set(") ? "set" : "enum";
  if (r === "boolean" || r === "bool" || t === "boolean" || t === "tinyint(1)") return "bool";
  if (/^(json|jsonb)$/.test(t) || r === "json" || r === "jsonb") return "json";
  if (/^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary|bit|varbit|bit varying|geometry|point|linestring|polygon)/.test(t) || /^(bytea|blob|binary|varbinary|geometry)/.test(r))
    return "binary";
  if (t === "uuid") return "uuid";
  if (t === "date") return "date";
  if (t === "year") return "year";
  if (/^(timestamp|datetime)/.test(t) || /^(timestamp|timestamptz|datetime)/.test(r)) return "datetime";
  if (/^time/.test(t) || /^(time|timetz)$/.test(r)) return "time";
  if (r === "enum") return "enum";
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|serial|bigserial|smallserial|decimal|numeric|real|double|float|year)/.test(t) || /^(int|bigint|smallint|real|double|numeric|decimal|float|tinyint|mediumint)/.test(r))
    return "number";
  return "text";
}

/** Truthiness for MySQL 1/0 and Postgres true/false. */
export const isTruthy = (v: string) => v === "1" || v.toLowerCase() === "true" || v === "t";

const NUM = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
export const looksNumeric = (v: string) => NUM.test(v.trim());

/** Splits "2025-09-01 10:24:12.345+02" into the picker part and the time zone suffix. */
export function splitTz(v: string): { local: string; tz: string } {
  const m = /([+-]\d{2}(:?\d{2})?|Z)$/.exec(v.trim());
  if (!m) return { local: v.trim(), tz: "" };
  return { local: v.trim().slice(0, m.index).trim(), tz: m[0] };
}

export type TsUnit = "s" | "ms";

// 2000-01-01 .. 2100-01-01 in seconds
const TS_MIN = 946_684_800;
const TS_MAX = 4_102_444_800;
const INT_TYPE = /^(int|integer|bigint|serial|bigserial|int4|int8)\b/;
const TS_NAME = /(_at|_on|_ts)$|^ts$|time|date|epoch|created|updated|modified|deleted|expire|last_?(seen|login|active)/i;
const NOT_TS_NAME = /(^|_)(id|count|cnt|num|qty|size|amount|price|total|bytes)$/i;

/** Unit of an integer that falls in the plausible Unix timestamp range, else null. */
export function unixTsUnitOf(v: string): TsUnit | null {
  if (!/^\d{9,13}$/.test(v)) return null;
  const n = Number(v);
  if (n >= TS_MIN && n < TS_MAX) return "s";
  if (n >= TS_MIN * 1000 && n < TS_MAX * 1000) return "ms";
  return null;
}

/**
 * Whether an integer column holds Unix timestamps, judged by its name and the loaded values;
 * returns the dominant unit (null = not a timestamp column).
 */
export function unixTsColumn(name: string, typeName: string, col: StructColumn | null | undefined, values: (string | null | undefined)[]): TsUnit | null {
  const t = (col?.columnType ?? typeName).toLowerCase().trim();
  if (!INT_TYPE.test(t) && !INT_TYPE.test(typeName.toLowerCase())) return null;
  if (col?.autoIncrement || col?.primaryKey || NOT_TS_NAME.test(name)) return null;
  let s = 0;
  let ms = 0;
  let other = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === "" || v === "0") continue;
    const u = unixTsUnitOf(v);
    if (u === "s") s++;
    else if (u === "ms") ms++;
    else other++;
  }
  const hits = s + ms;
  const unit: TsUnit = ms > s ? "ms" : "s";
  // a suggestive name only needs most values to fit; otherwise the values have to be convincing
  if (TS_NAME.test(name)) return hits >= other ? unit : null;
  return hits >= 3 && other === 0 ? unit : null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "2025-09-01 10:24:12" in local time (or UTC), with milliseconds when present. */
export function formatEpoch(ms: number, utc = false): string {
  const d = new Date(ms);
  const g = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
  const frac = g[6] ? `.${String(g[6]).padStart(3, "0")}` : "";
  return `${g[0]}-${pad2(g[1])}-${pad2(g[2])} ${pad2(g[3])}:${pad2(g[4])}:${pad2(g[5])}${frac}`;
}

export interface UnixTsInfo {
  unit: TsUnit;
  ms: number;
  local: string;
  utc: string;
  /** "UTC+02:00" */
  zone: string;
}

/** Converted Unix timestamp, or null when the value isn't one. */
export function unixTsInfo(v: string): UnixTsInfo | null {
  const unit = unixTsUnitOf(v);
  if (!unit) return null;
  const ms = unit === "ms" ? Number(v) : Number(v) * 1000;
  const off = -new Date(ms).getTimezoneOffset();
  const zone = `UTC${off >= 0 ? "+" : "-"}${pad2(Math.floor(Math.abs(off) / 60))}:${pad2(Math.abs(off) % 60)}`;
  return { unit, ms, local: formatEpoch(ms), utc: formatEpoch(ms, true), zone };
}

/** "3 days ago" / "in 2 hours". */
export function relativeTime(ms: number, now = Date.now()): string {
  const sec = Math.round((ms - now) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [u, n] of steps) if (Math.abs(sec) >= n) return rtf.format(Math.trunc(sec / n), u);
  return rtf.format(sec, "second");
}
