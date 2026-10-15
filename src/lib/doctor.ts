// Table Doctor: analysis results per tab and fixes that run as background jobs.
import { create } from "zustand";
import { api, errorText, type Finding, type TableHealth } from "./api";
import { useStore } from "../store";
import { baseId } from "./connIds";
import { isProduction } from "./connStyle";
import { startSqlJob } from "./importJobs";
import { splitStatements } from "./sql";

export interface DoctorResult {
  health?: TableHealth;
  /** When `health` was loaded */
  at?: number;
  loading?: boolean;
  error?: string;
  /** Finding id -> background job running its fix */
  fixes?: Record<string, string>;
}

// Not persisted: a restored tab analyzes again.
export const useDoctor = create<{ byTab: Record<string, DoctorResult> }>(() => ({ byTab: {} }));

const patch = (tabId: string, p: Partial<DoctorResult>) =>
  useDoctor.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { ...s.byTab[tabId], ...p } } }));

const tabOf = (tabId: string) => useStore.getState().tabs.find((t) => t.id === tabId);

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

export async function analyzeTab(tabId: string) {
  const tab = tabOf(tabId);
  if (!tab?.doctor || !tab.connId || useDoctor.getState().byTab[tabId]?.loading) return;
  const { connId, doctor } = tab;
  patch(tabId, { loading: true, error: undefined });
  try {
    const st = useStore.getState();
    if (st.conn[connId]?.status !== "connected" && !(await st.connectTo(connId))) {
      throw new Error(useStore.getState().conn[connId]?.error ?? "Could not connect.");
    }
    const health = await api.analyzeTable(connId, doctor.schema, doctor.table);
    patch(tabId, { health, at: Date.now(), loading: false });
  } catch (e) {
    patch(tabId, { loading: false, error: errorText(e) });
  }
}

/** Shows the fix SQL for confirmation (editable; production needs a tick), then runs it in the background. */
export function confirmFix(tabId: string, f: Finding) {
  const tab = tabOf(tabId);
  if (!f.fix || !tab?.doctor || !tab.connId) return;
  const fix = f.fix;
  const cfg = useStore.getState().connections.find((c) => c.id === baseId(tab.connId));
  const prod = isProduction(cfg);
  useStore.getState().setUi({
    actionDialog: {
      title: `${fix.label} · ${tab.doctor.table}`,
      connId: tab.connId,
      message: [f.title, fix.note].filter(Boolean).join(". "),
      danger: /^\s*drop\b|\bdrop index\b|\bvacuum \(full\b|\balter column\b|\bengine\s*=/i.test(fix.sql),
      confirmLabel: fix.long ? `${fix.label} in background` : fix.label,
      acknowledge: prod ? "I understand this changes a PRODUCTION database." : undefined,
      buildSql: () => fix.sql,
      onRun: (sql) => void runFix(tabId, f, sql),
    },
  });
}

async function runFix(tabId: string, f: Finding, sql: string) {
  const tab = tabOf(tabId);
  if (!tab?.doctor || !tab.connId) return;
  const cfg = useStore.getState().connections.find((c) => c.id === baseId(tab.connId));
  const statements = splitStatements(sql, cfg?.kind ?? "postgres").map((s) => s.text);
  const setJob = (jobId?: string) => {
    const fixes = { ...useDoctor.getState().byTab[tabId]?.fixes };
    if (jobId) fixes[f.id] = jobId;
    else delete fixes[f.id];
    patch(tabId, { fixes });
  };
  await startSqlJob(
    { title: `${f.fix?.label ?? "Fix"} · ${tab.doctor.table}`, target: `${cfg?.name ?? "connection"} / ${tab.doctor.schema}.${tab.doctor.table}`, connId: tab.connId },
    statements,
    setJob,
  );
  setJob();
  // re-check even after a failure: part of it may have run
  if (tabOf(tabId)) void analyzeTab(tabId);
}
