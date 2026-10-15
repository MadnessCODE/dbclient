// Table Doctor: analysis results per tab, schema scans for tree badges and Database Doctor,
// ignored findings and fixes that run as background jobs.
import { create } from "zustand";
import { api, errorText, type Finding, type SchemaTree, type Severity, type TableHealth, type TableReport } from "./api";
import { useStore } from "../store";
import { baseId } from "./connIds";
import { isProduction } from "./connStyle";
import { startScanJob, startSqlJob } from "./importJobs";
import { splitStatements } from "./sql";

export interface DoctorRef {
  connId: string;
  schema: string;
  table: string;
}

export const refKey = (r: DoctorRef) => `${r.connId}|${r.schema}|${r.table}`;
const schemaKey = (connId: string, schema: string) => `${connId}|${schema}`;

export const WEIGHT: Record<Severity, number> = { critical: 25, warning: 10, info: 2 };

/** Same as the backend's score, for findings without the ignored ones. */
export const scoreOf = (findings: Finding[]) => Math.max(0, 100 - findings.reduce((a, f) => a + WEIGHT[f.severity], 0));

export function ignoredIds(r: DoctorRef): string[] {
  return useStore.getState().doctorIgnored[refKey(r)] ?? [];
}

/** Findings split into the ones that count and the ones the user ignored. */
export function splitIgnored(findings: Finding[], ignored: string[]) {
  return { active: findings.filter((f) => !ignored.includes(f.id)), ignored: findings.filter((f) => ignored.includes(f.id)) };
}

export const setIgnored = (r: DoctorRef, f: Finding, ignored: boolean) => useStore.getState().setIgnored(refKey(r), f.id, ignored);

export interface TableResult {
  health?: TableHealth;
  /** When `health` was loaded */
  at?: number;
  loading?: boolean;
  error?: string;
}

/** A schema scan: tree badges, and the source of Database Doctor. */
export interface SchemaResult {
  tables?: Record<string, TableReport>;
  notes?: string[];
  loading?: boolean;
  error?: string;
  /** Schema tree the badges were loaded for; a refreshed tree loads them again */
  tree?: SchemaTree;
}

export interface DbResult {
  /** Schemas scanned so far */
  done: string[];
  error?: string;
  jobId?: string;
  at?: number;
}

interface DoctorState {
  byTab: Record<string, TableResult>;
  schemas: Record<string, SchemaResult>;
  dbTabs: Record<string, DbResult>;
  /** "<refKey>#<finding id>" -> background job running its fix */
  fixes: Record<string, string>;
}

// Not persisted: restored tabs analyze again.
export const useDoctor = create<DoctorState>(() => ({ byTab: {}, schemas: {}, dbTabs: {}, fixes: {} }));

const patchTab = (tabId: string, p: Partial<TableResult>) => useDoctor.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { ...s.byTab[tabId], ...p } } }));
const patchSchema = (key: string, p: Partial<SchemaResult>) => useDoctor.setState((s) => ({ schemas: { ...s.schemas, [key]: { ...s.schemas[key], ...p } } }));
const patchDb = (tabId: string, p: Partial<DbResult>) =>
  useDoctor.setState((s) => ({ dbTabs: { ...s.dbTabs, [tabId]: { ...(s.dbTabs[tabId] ?? { done: [] }), ...p } } }));

export const schemaResult = (s: DoctorState, connId: string, schema: string) => s.schemas[schemaKey(connId, schema)];

const tabOf = (tabId: string) => useStore.getState().tabs.find((t) => t.id === tabId);

async function ensureConnected(connId: string) {
  const st = useStore.getState();
  if (st.conn[connId]?.status !== "connected" && !(await st.connectTo(connId))) {
    throw new Error(useStore.getState().conn[connId]?.error ?? "Could not connect.");
  }
}

/** Opens the Table Doctor tab for a table, or focuses and re-runs an open one. */
export function openDoctor(connId: string, schema: string, table: string, database?: string) {
  const st = useStore.getState();
  const open = st.tabs.find((t) => t.doctor && t.connId === connId && t.doctor.schema === schema && t.doctor.table === table);
  if (open) {
    st.setActiveTab(open.id);
    void analyzeTab(open.id);
    return;
  }
  st.newTab({ title: `${table} · health`, connId, doctor: { schema, table }, database });
}

/** Opens Database Doctor for some schemas of a connection (a new scan when it is already open). */
export function openDbDoctor(connId: string, schemas: string[], label: string) {
  const st = useStore.getState();
  const open = st.tabs.find((t) => t.dbDoctor && t.connId === connId && t.dbDoctor.label === label);
  if (open) {
    st.setActiveTab(open.id);
    void scanTab(open.id);
    return;
  }
  st.newTab({ title: `${label} · health`, connId, dbDoctor: { schemas, label } });
}

export async function analyzeTab(tabId: string) {
  const tab = tabOf(tabId);
  if (!tab?.doctor || !tab.connId || useDoctor.getState().byTab[tabId]?.loading) return;
  const { connId, doctor } = tab;
  patchTab(tabId, { loading: true, error: undefined });
  try {
    await ensureConnected(connId);
    const health = await api.analyzeTable(connId, doctor.schema, doctor.table);
    patchTab(tabId, { health, at: Date.now(), loading: false });
    // keep the tree badge of this table in step
    const key = schemaKey(connId, doctor.schema);
    const sch = useDoctor.getState().schemas[key];
    if (sch?.tables) {
      const prev = sch.tables[doctor.table];
      const bytes = (health.stats.tableBytes ?? 0) + (health.stats.indexBytes ?? 0) + (health.stats.toastBytes ?? 0);
      patchSchema(key, { tables: { ...sch.tables, [doctor.table]: { ...prev, table: doctor.table, rows: health.stats.rows, bytes, findings: health.findings } } });
    }
  } catch (e) {
    patchTab(tabId, { loading: false, error: errorText(e) });
  }
}

/** Scans one schema (badges and Database Doctor share the result). */
export async function loadSchema(connId: string, schema: string, tree?: SchemaTree) {
  const key = schemaKey(connId, schema);
  patchSchema(key, { loading: true, error: undefined, tree });
  try {
    const res = await api.analyzeSchema(connId, schema);
    patchSchema(key, { loading: false, notes: res.notes, tables: Object.fromEntries(res.tables.map((t) => [t.table, t])) });
  } catch (e) {
    patchSchema(key, { loading: false, error: errorText(e) });
    throw e;
  }
}

/** Badges for a schema shown in the tree: scanned once per loaded schema tree. */
export function ensureBadges(connId: string, schema: string) {
  const st = useStore.getState();
  if (st.settings.doctorBadges === false || st.conn[connId]?.status !== "connected") return;
  const tree = st.conn[connId]?.schema;
  const cur = useDoctor.getState().schemas[schemaKey(connId, schema)];
  if (cur?.loading || (cur?.tree === tree && (cur?.tables || cur?.error))) return;
  // badges are a convenience: a failed scan just shows none
  loadSchema(connId, schema, tree).catch(() => undefined);
}

/** Database Doctor: scans its schemas one by one as a background task. */
export async function scanTab(tabId: string) {
  const tab = tabOf(tabId);
  if (!tab?.dbDoctor || !tab.connId) return;
  const cur = useDoctor.getState().dbTabs[tabId];
  if (cur?.jobId && !cur.at && !cur.error) return;
  const { connId, dbDoctor } = tab;
  const cfg = useStore.getState().connections.find((c) => c.id === baseId(connId));
  patchDb(tabId, { done: [], error: undefined, at: undefined });
  try {
    await ensureConnected(connId);
  } catch (e) {
    patchDb(tabId, { error: errorText(e) });
    return;
  }
  const ok = await startScanJob(
    { title: `Analyze ${dbDoctor.label}`, target: cfg?.name ?? "connection", connId },
    dbDoctor.schemas,
    async (schema) => {
      await loadSchema(connId, schema, useStore.getState().conn[connId]?.schema);
      patchDb(tabId, { done: [...(useDoctor.getState().dbTabs[tabId]?.done ?? []), schema] });
    },
    (jobId) => patchDb(tabId, { jobId }),
  );
  patchDb(tabId, ok.error ? { error: ok.error, at: Date.now() } : { at: Date.now() });
}

/** Tables of a Database Doctor tab with their schema, from the shared schema scans. */
export function dbTables(results: Record<string, SchemaResult>, connId: string, schemas: string[]) {
  return schemas.flatMap((schema) => Object.values(results[schemaKey(connId, schema)]?.tables ?? {}).map((t) => ({ ...t, schema })));
}

/** Shows the fix SQL for confirmation (editable; production needs a tick), then runs it in the background. */
export function confirmFix(r: DoctorRef, f: Finding) {
  if (!f.fix) return;
  const fix = f.fix;
  const cfg = useStore.getState().connections.find((c) => c.id === baseId(r.connId));
  const prod = isProduction(cfg);
  useStore.getState().setUi({
    actionDialog: {
      title: `${fix.label} · ${r.table}`,
      connId: r.connId,
      message: [f.title, fix.note].filter(Boolean).join(". "),
      danger: /^\s*drop\b|\bdrop index\b|\bvacuum \(full\b|\balter column\b|\bengine\s*=/i.test(fix.sql),
      confirmLabel: fix.long ? `${fix.label} in background` : fix.label,
      acknowledge: prod ? "I understand this changes a PRODUCTION database." : undefined,
      buildSql: () => fix.sql,
      onRun: (sql) => void runFix(r, f, sql),
    },
  });
}

async function runFix(r: DoctorRef, f: Finding, sql: string) {
  const cfg = useStore.getState().connections.find((c) => c.id === baseId(r.connId));
  const statements = splitStatements(sql, cfg?.kind ?? "postgres").map((s) => s.text);
  const key = `${refKey(r)}#${f.id}`;
  const setJob = (jobId?: string) =>
    useDoctor.setState((s) => {
      const fixes = { ...s.fixes };
      if (jobId) fixes[key] = jobId;
      else delete fixes[key];
      return { fixes };
    });
  await startSqlJob({ title: `${f.fix?.label ?? "Fix"} · ${r.table}`, target: `${cfg?.name ?? "connection"} / ${r.schema}.${r.table}`, connId: r.connId }, statements, setJob);
  setJob();
  // re-check even after a failure: part of it may have run
  for (const t of useStore.getState().tabs) {
    if (t.doctor && t.connId === r.connId && t.doctor.schema === r.schema && t.doctor.table === r.table) void analyzeTab(t.id);
  }
  if (useDoctor.getState().schemas[schemaKey(r.connId, r.schema)]) loadSchema(r.connId, r.schema, useStore.getState().conn[r.connId]?.schema).catch(() => undefined);
}

/** ANALYZE for a table without column statistics, through the same confirmation. */
export function confirmAnalyze(r: DoctorRef, kind: "postgres" | "mysql") {
  const q = (n: string) => (kind === "mysql" ? `\`${n.replace(/`/g, "``")}\`` : `"${n.replace(/"/g, '""')}"`);
  const finding: Finding = {
    id: "column-stats",
    severity: "info",
    title: "Collect column statistics",
    detail: "",
    evidence: [],
    fix: {
      label: "Analyze",
      sql: `${kind === "mysql" ? "ANALYZE TABLE" : "ANALYZE"} ${q(r.schema)}.${q(r.table)};`,
      note: "Reads a sample of the table; doesn't block reads or writes.",
      long: true,
    },
  };
  confirmFix(r, finding);
}
