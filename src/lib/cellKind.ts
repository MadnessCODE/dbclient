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
