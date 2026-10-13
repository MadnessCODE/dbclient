// Types and calls for the Rust commands (src-tauri/src/lib.rs).
import { invoke } from "@tauri-apps/api/core";

export type DbKind = "postgres" | "mysql";
export type SslMode = "disable" | "prefer" | "require";

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth: "password" | "key";
  keyPath: string;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: SslMode;
  savePassword: boolean;
  ssh?: SshConfig | null;
  /** Palette color key (lib/connStyle.ts) */
  color?: string | null;
  environment?: "dev" | "staging" | "production" | null;
  projectId?: string | null;
}

export type ProjectIconDef =
  | { type: "lucide"; name: string }
  | { type: "emoji"; value: string }
  | { type: "image"; dataUrl: string };

export interface Project {
  id: string;
  name: string;
  color?: string | null;
  icon?: ProjectIconDef | null;
}

export interface ConnectionInput extends ConnectionConfig {
  /** null = keep the saved password */
  password: string | null;
  /** SSH password or key passphrase; null = keep the saved one */
  sshSecret: string | null;
}

export interface ServerInfo {
  database: string;
  user: string;
  version: string;
  versionFull: string;
  host: string;
  port: number;
  ssl: boolean;
}

export interface SchemaInfo {
  name: string;
  system: boolean;
  tables: string[];
  views: string[];
  matViews: string[];
  functions: string[];
  procedures: string[];
  triggers: string[];
  /** Table sizes from server statistics, by table name */
  tableStats: Record<string, TableStat>;
}

export interface TableStat {
  /** Estimate; null if the table hasn't been analyzed */
  rows: number | null;
  dataBytes: number;
  indexBytes: number;
}

export interface ColumnInfo {
  schema: string;
  table: string;
  name: string;
  dataType: string;
  nullable: boolean;
}

export interface SchemaTree {
  schemas: SchemaInfo[];
  columns: ColumnInfo[];
}

export interface StructColumn {
  name: string;
  columnType: string;
  nullable: boolean;
  /** SQL expression (strings already quoted) */
  default: string | null;
  primaryKey: boolean;
  autoIncrement: boolean;
  comment: string | null;
  collation: string | null;
  extra: string | null;
  /** Allowed values of ENUM / MySQL SET */
  enumValues: string[] | null;
}

export interface StructIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string;
  constraint: boolean;
}

export interface StructForeignKey {
  name: string;
  tableSchema: string;
  table: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface TableStructure {
  schema: string;
  table: string;
  isView: boolean;
  columns: StructColumn[];
  indexes: StructIndex[];
  foreignKeys: StructForeignKey[];
  referencedBy: StructForeignKey[];
  ddl: string;
  engine: string | null;
  rowEstimate: string | null;
  sizeBytes: string | null;
  tableComment: string | null;
  collation: string | null;
}

export type Cell = string | null;

export interface ColumnRef {
  schema: string;
  table: string;
  column: string;
}

export interface ColumnMeta {
  name: string;
  typeName: string;
  /** Source table/column (null for expressions) */
  origin: ColumnRef | null;
  /** Foreign key target */
  fk: ColumnRef | null;
}

export interface ResultSet {
  columns: ColumnMeta[];
  rows: Cell[][];
  returnsRows: boolean;
  rowsAffected: number;
  truncated: boolean;
}

export interface QueryOutput {
  resultSets: ResultSet[];
  elapsedMs: number;
}

export const api = {
  listConnections: () => invoke<ConnectionConfig[]>("list_connections"),
  listProjects: () => invoke<Project[]>("list_projects"),
  saveProject: (project: Project) => invoke<Project>("save_project", { project }),
  deleteProject: (id: string) => invoke<void>("delete_project", { id }),
  moveConnections: (ids: string[], projectId: string | null) => invoke<ConnectionConfig[]>("move_connections", { ids, projectId }),
  saveConnection: (input: ConnectionInput) => invoke<ConnectionConfig>("save_connection", { input }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  testConnection: (input: ConnectionInput) => invoke<ServerInfo>("test_connection", { input }),
  connect: (id: string, password?: string, sshSecret?: string) =>
    invoke<ServerInfo>("connect", { id, password: password ?? null, sshSecret: sshSecret ?? null }),
  listKnownHosts: () => invoke<[string, string][]>("list_known_hosts"),
  forgetKnownHost: (host: string) => invoke<void>("forget_known_host", { host }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),
  getSchema: (id: string) => invoke<SchemaTree>("get_schema", { id }),
  getTableStructure: (id: string, schema: string, table: string) =>
    invoke<TableStructure>("get_table_structure", { id, schema, table }),
  listCollations: (id: string) => invoke<string[]>("list_collations", { id }),
  runQuery: (connId: string, queryId: string, sql: string, maxRows: number) =>
    invoke<QueryOutput>("run_query", { connId, queryId, sql, maxRows }),
  executeBatch: (connId: string, statements: string[]) => invoke<number[]>("execute_batch", { connId, statements }),
  cancelQuery: (queryId: string) => invoke<boolean>("cancel_query", { queryId }),
  explainQuery: (connId: string, sql: string) => invoke<string>("explain_query", { connId, sql }),
  writeTextFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
  exportXlsx: (path: string, columns: { name: string; kind: string }[], rows: Cell[][], options: { sheet: string; header: boolean; nullAs: string }) =>
    invoke<void>("export_xlsx", { path, columns, rows, options }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  inspectDump: (path: string) => invoke<DumpInfo>("inspect_dump", { path }),
  importDump: (connId: string, jobId: string, options: ImportOptions) => invoke<ImportSummary>("import_dump", { connId, jobId, options }),
  cancelImport: (jobId: string) => invoke<boolean>("cancel_import", { jobId }),
  previewTableFile: (options: SourceOptions) => invoke<SourcePreview>("preview_table_file", { options }),
  importTableFile: (connId: string, jobId: string, options: TableImportOptions) => invoke<ImportSummary>("import_table_file", { connId, jobId, options }),
};

export interface ImportOptions {
  path: string;
  workers: number;
  fast: boolean;
  continueOnError: boolean;
  database: string | null;
  createDatabase: boolean;
  stripDefiner: boolean;
}

export interface ImportError {
  line: number;
  message: string;
  sql: string;
}

export interface ImportProgress {
  jobId: string;
  doneBytes: number;
  /** "bytes", or "rows" for Excel */
  unit: "bytes" | "rows";
  totalBytes: number;
  statements: number;
  rows: number;
  errorCount: number;
  table: string;
  elapsedMs: number;
  activeWorkers: number;
  /** The first is the main connection (DDL, ordered statements); the rest run in parallel */
  workers: WorkerView[];
}

export interface WorkerView {
  busy: boolean;
  task: "insert" | "copy" | "index" | "sql" | "";
  table: string;
  jobs: number;
}

export type TableFormat = "csv" | "excel" | "json";

export interface SourceOptions {
  path: string;
  format: TableFormat;
  /** "" = detect */
  delimiter: string;
  /** "" = detect */
  encoding: string;
  header: boolean;
  sheet: string | null;
}

export interface ColumnGuess {
  kind: "int" | "bigint" | "decimal" | "double" | "bool" | "date" | "datetime" | "json" | "text";
  maxLen: number;
  precision: number;
  scale: number;
  nullable: boolean;
}

export interface SourcePreview {
  delimiter: string;
  encoding: string;
  sheets: string[];
  sheet: string | null;
  columns: { name: string; guess: ColumnGuess }[];
  rows: Cell[][];
  totalRows: number | null;
}

export interface TableImportOptions {
  source: SourceOptions;
  sourceColumns: string[];
  schema: string | null;
  table: string;
  mapping: { source: number; target: string }[];
  before: string[];
  onConflict: "error" | "skip" | "update";
  keyColumns: string[];
  emptyAsNull: boolean;
  /** Boolean target columns (true/false are sent as 1/0) */
  boolColumns: string[];
  workers: number;
  continueOnError: boolean;
  database: string | null;
}

export interface DumpInfo {
  size: number;
  gzip: boolean;
  text: boolean;
  dialect: "mysql" | "postgres" | null;
  detected: string | null;
}

export interface ImportSummary {
  statements: number;
  rows: number;
  bytes: number;
  elapsedMs: number;
  cancelled: boolean;
  failed: boolean;
  errorCount: number;
  errors: ImportError[];
  notes: string[];
}

export const kindLabel = (kind: DbKind) => (kind === "postgres" ? "PostgreSQL" : "MySQL");
export const defaultPort = (kind: DbKind) => (kind === "postgres" ? 5432 : 3306);

/** Rust errors arrive as strings. */
export const errorText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
