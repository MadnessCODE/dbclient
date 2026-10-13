// Monaco is bundled locally (not from a CDN) so the editor works offline.
import type * as MonacoApi from "monaco-editor";
import * as monacoLean from "./monaco-lean";
import EditorWorker from "./editor.worker?worker";
import { loader } from "@monaco-editor/react";
import type { DbKind, SchemaTree } from "./api";

const monaco = monacoLean as unknown as typeof MonacoApi;

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

monaco.editor.defineTheme("dbclient-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "e879c6" },
    { token: "operator", foreground: "e879c6" },
    { token: "string", foreground: "f6a35b" },
    { token: "number", foreground: "f6a35b" },
    { token: "comment", foreground: "5f6f8f", fontStyle: "italic" },
    { token: "predefined", foreground: "6fd3ee" },
    { token: "identifier", foreground: "d6e2f5" },
    { token: "identifier.quote", foreground: "6fd3ee" },
    { token: "delimiter", foreground: "9fb0cc" },
  ],
  colors: {
    "editor.background": "#0b1324",
    "editor.foreground": "#d6e2f5",
    "editorLineNumber.foreground": "#4b5a78",
    "editorLineNumber.activeForeground": "#b4c0d6",
    "editor.lineHighlightBackground": "#101b33",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#2f6fed55",
    "editorCursor.foreground": "#6fa0ff",
    "editorGutter.background": "#0b1324",
    "editorWidget.background": "#0e1830",
    "editorWidget.border": "#24365a",
    "editorSuggestWidget.background": "#0e1830",
    "editorSuggestWidget.border": "#24365a",
    "editorSuggestWidget.selectedBackground": "#1b3260",
    "scrollbarSlider.background": "#24365a88",
  },
});

monaco.editor.defineTheme("dbclient-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "a626a4" },
    { token: "operator", foreground: "a626a4" },
    { token: "string", foreground: "c2560c" },
    { token: "number", foreground: "c2560c" },
    { token: "comment", foreground: "8a96ab", fontStyle: "italic" },
    { token: "predefined", foreground: "0e7490" },
    { token: "identifier", foreground: "0f1b31" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editorLineNumber.foreground": "#a3aec2",
    "editor.lineHighlightBackground": "#f3f6fb",
    "editor.lineHighlightBorder": "#00000000",
  },
});


interface CompletionContext {
  schema?: SchemaTree;
  kind?: DbKind;
}

/** Set by the editor to the active tab's schema. */
let currentContext: () => CompletionContext = () => ({});
export const setCompletionContext = (fn: () => CompletionContext) => {
  currentContext = fn;
};

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS NULL", "IS NOT NULL", "LIKE", "ILIKE", "BETWEEN",
  "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL OUTER JOIN", "CROSS JOIN", "ON", "USING", "AS",
  "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "DISTINCT", "UNION", "UNION ALL", "EXCEPT", "INTERSECT",
  "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "RETURNING", "WITH", "CASE", "WHEN", "THEN", "ELSE", "END",
  "CREATE TABLE", "CREATE INDEX", "CREATE VIEW", "ALTER TABLE", "DROP TABLE", "TRUNCATE", "PRIMARY KEY",
  "FOREIGN KEY", "REFERENCES", "DEFAULT", "NULL", "TRUE", "FALSE", "ASC", "DESC", "EXISTS", "BEGIN", "COMMIT", "ROLLBACK",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NOW()", "EXPLAIN",
];

const NOT_ALIAS = new Set([
  "where", "on", "join", "left", "right", "inner", "outer", "full", "cross", "group", "order", "limit", "using",
  "union", "having", "set", "natural", "lateral", "offset", "returning", "window",
]);

/** "FROM users u JOIN facilities AS f" -> { u: "users", f: "facilities", users: "users", ... } */
function aliasesIn(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:from|join|update|into)\s+([\w$."`]+)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
  for (const m of sql.matchAll(re)) {
    const table = m[1].replace(/[`"]/g, "").split(".").pop()!.toLowerCase();
    map.set(table, table);
    const alias = m[2]?.toLowerCase();
    if (alias && !NOT_ALIAS.has(alias)) map.set(alias, table);
  }
  return map;
}

monaco.languages.registerCompletionItemProvider("sql", {
  triggerCharacters: ["."],
  provideCompletionItems(model, position) {
    const { schema } = currentContext();
    const word = model.getWordUntilPosition(position);
    const range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };
    const before = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: word.startColumn,
    });
    const K = monaco.languages.CompletionItemKind;
    const suggestions: MonacoApi.languages.CompletionItem[] = [];
    const aliases = aliasesIn(model.getValue());
    const columns = schema?.columns ?? [];
    const userSchemas = schema?.schemas.filter((s) => !s.system) ?? [];

    // "u." / "users." / "public." -> table columns, or the schema's tables
    const dot = /([\w$]+)\.$/.exec(before);
    if (dot) {
      const q = dot[1].toLowerCase();
      const table = aliases.get(q) ?? q;
      for (const c of columns.filter((c) => c.table.toLowerCase() === table)) {
        suggestions.push({ label: c.name, kind: K.Field, detail: c.dataType, insertText: c.name, range, sortText: "0" });
      }
      const s = schema?.schemas.find((s) => s.name.toLowerCase() === q);
      if (s) {
        for (const t of s.tables) suggestions.push({ label: t, kind: K.Class, detail: "table", insertText: t, range });
        for (const v of [...s.views, ...s.matViews]) suggestions.push({ label: v, kind: K.Interface, detail: "view", insertText: v, range });
        for (const f of s.functions) suggestions.push({ label: f, kind: K.Function, detail: "function", insertText: `${f}()`, range });
      }
      return { suggestions };
    }

    // Columns of tables already in the query come first
    const used = new Set(aliases.values());
    for (const c of columns) {
      if (!used.has(c.table.toLowerCase())) continue;
      suggestions.push({ label: c.name, kind: K.Field, detail: `${c.table} · ${c.dataType}`, insertText: c.name, range, sortText: "0" });
    }
    for (const s of userSchemas) {
      for (const t of s.tables) suggestions.push({ label: t, kind: K.Class, detail: `table · ${s.name}`, insertText: t, range, sortText: "1" });
      for (const v of [...s.views, ...s.matViews]) suggestions.push({ label: v, kind: K.Interface, detail: `view · ${s.name}`, insertText: v, range, sortText: "1" });
      for (const f of s.functions) suggestions.push({ label: f, kind: K.Function, detail: `function · ${s.name}`, insertText: `${f}()`, range, sortText: "2" });
    }
    for (const kw of KEYWORDS) suggestions.push({ label: kw, kind: K.Keyword, insertText: kw, range, sortText: "3" });
    return { suggestions };
  },
});

export { monaco };
