// ER diagram: model from the server + a self-contained HTML page (viewer.js / viewer.css).
import css from "./viewer.css?raw";
import js from "./viewer.js?raw";
import { invoke } from "@tauri-apps/api/core";
import type { DbKind } from "../api";

export interface ErColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
  comment: string | null;
}

export interface ErTable {
  name: string;
  kind: "table" | "view";
  comment: string | null;
  columns: ErColumn[];
  indexes: { name: string; columns: string[]; unique: boolean; primary: boolean }[];
  foreignKeys: { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[]; onDelete: string; onUpdate: string }[];
}

export interface ErModel {
  title: string;
  subtitle: string;
  schema: string;
  kind: DbKind;
  theme: "dark" | "light";
  tables: ErTable[];
  /** Shown inside the app, which has its own title bar */
  embedded?: boolean;
  /** Saved table positions (top-left corners); missing tables are laid out automatically */
  positions?: Record<string, { x: number; y: number }>;
}

export const loadErTables = (id: string, schema: string) => invoke<ErTable[]>("er_model", { id, schema });

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function buildErHtml(model: ErModel) {
  // "</script" inside the JSON would end the script tag
  const data = JSON.stringify(model).replace(/</g, "\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="DB Client" />
<title>${escHtml(model.title)} · ER diagram</title>
<style>${css}</style>
</head>
<body>
<script type="application/json" id="er-model">${data}</script>
<script>${js}</script>
</body>
</html>
`;
}
