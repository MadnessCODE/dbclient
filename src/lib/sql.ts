// SQL text helpers: statement splitting, statement under the cursor, identifiers.

export interface Statement {
  text: string;
  start: number;
  end: number;
}

/** Splits on ';' outside strings, quoted identifiers, comments and Postgres $tag$ blocks. */
export function splitStatements(sql: string, kind: "postgres" | "mysql" = "postgres"): Statement[] {
  const mysql = kind === "mysql";
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const raw = sql.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) out.push({ text, start: start + lead, end: start + lead + text.length });
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (c === "#" && mysql) {
      // MySQL line comment
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (c === "/" && next === "*") {
      const endc = sql.indexOf("*/", i + 2);
      i = endc === -1 ? sql.length : endc + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && mysql) i += 2;
        else if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) break;
        else i++;
      }
      i++;
    } else if (c === "$" && !mysql) {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        i = close === -1 ? sql.length : close + m[0].length;
      } else i++;
    } else if (c === ";") {
      push(i);
      start = i + 1;
      i++;
    } else i++;
  }
  push(sql.length);
  return out;
}

/** The statement at the cursor (or the last one before it). */
export function statementAt(sql: string, offset: number, kind: "postgres" | "mysql" = "postgres"): Statement | null {
  const all = splitStatements(sql, kind);
  if (all.length === 0) return null;
  let best = all[0];
  for (const s of all) {
    if (s.start <= offset) best = s;
    if (offset <= s.end + 1 && offset >= s.start) return s;
  }
  return best;
}

const NUMERIC = /^(bigint|integer|int|smallint|tinyint|mediumint|real|double|float|numeric|decimal|oid|money|year)/;
export const isNumericType = (t: string) => NUMERIC.test(t);

/** First identifier after FROM, used as the tab title ("users.sql"). */
export function guessTitle(sql: string): string | null {
  const m = /\bfrom\s+([`"\w.]+)/i.exec(sql);
  if (!m) return null;
  const name = m[1].replace(/[`"]/g, "").split(".").pop();
  return name ? `${name}.sql` : null;
}

export function quoteIdent(name: string, kind: "postgres" | "mysql") {
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name;
  return kind === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}
