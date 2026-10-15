// Background imports, exports and maintenance SQL: jobs outlive the progress dialog, which can
// be closed and reopened; completion or failure is reported with a notification.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { api, errorText, type ImportProgress, type ImportSummary } from "./api";
import { useStore } from "../store";

export interface ImportJob {
  id: string;
  kind: "dump" | "table" | "export" | "sql" | "scan";
  title: string;
  /** "connection / db.table" */
  target: string;
  connId: string;
  workers: number;
  fileSize: number;
  startedAt: number;
  progress?: ImportProgress;
  summary?: ImportSummary;
  error?: string;
  /** The user has seen the result */
  seen: boolean;
  /** Stop was clicked; running statements are finishing */
  stopping?: boolean;
  /** kind "sql": statements run one by one, "scan": items analyzed one by one; and how many have finished */
  statements?: string[];
  done?: number;
}

export interface Toast {
  id: string;
  tone: "ok" | "warn" | "error";
  title: string;
  body: string;
  jobId?: string;
}

interface State {
  jobs: ImportJob[];
  /** Job whose progress dialog is open */
  open: string | null;
  toasts: Toast[];
  show: (id: string | null) => void;
  dismiss: (id: string) => void;
  stop: (id: string) => void;
  clearFinished: () => void;
  closeToast: (id: string) => void;
}

export const useImports = create<State>()((set) => ({
  jobs: [],
  open: null,
  toasts: [],
  show: (id) =>
    set((s) => ({
      open: id,
      jobs: id ? s.jobs.map((j) => (j.id === id && isDone(j) ? { ...j, seen: true } : j)) : s.jobs,
      toasts: id ? s.toasts.filter((t) => t.jobId !== id) : s.toasts,
    })),
  dismiss: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id), open: s.open === id ? null : s.open })),
  stop: (id) => {
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, stopping: true } : j)) }));
    const job = useImports.getState().jobs.find((j) => j.id === id);
    // a scan stops between its steps
    if (job?.kind === "sql") void api.cancelQuery(id);
    else if (job?.kind !== "scan") void api.cancelImport(id);
  },
  clearFinished: () => set((s) => ({ jobs: s.jobs.filter((j) => !isDone(j)) })),
  closeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const isDone = (j: ImportJob) => !!j.summary || !!j.error;
export const isRunning = (j: ImportJob) => !isDone(j);

/** 0..100 */
export function jobPercent(j: ImportJob) {
  if (j.summary && !j.summary.failed && !j.summary.cancelled) return 100;
  if (j.kind === "sql" || j.kind === "scan") return j.statements?.length ? ((j.done ?? 0) / j.statements.length) * 100 : 0;
  const p = j.progress;
  const total = p?.totalBytes || j.fileSize;
  return total > 0 ? Math.min(100, ((p?.doneBytes ?? 0) / total) * 100) : 0;
}

const patch = (id: string, p: Partial<ImportJob>) => useImports.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) }));

/** Starts a background import and opens its progress dialog; `run` gets the job id and calls the Rust command. */
export async function startImport(meta: Omit<ImportJob, "id" | "startedAt" | "seen">, run: (jobId: string) => Promise<ImportSummary>) {
  const id = crypto.randomUUID();
  useImports.setState((s) => ({ jobs: [...s.jobs, { ...meta, id, startedAt: Date.now(), seen: false }], open: id }));
  const unlisten = await listen<ImportProgress>("import-progress", (e) => {
    if (e.payload.jobId === id) patch(id, { progress: e.payload });
  });
  try {
    const summary = await run(id);
    patch(id, { summary });
  } catch (e) {
    patch(id, { error: errorText(e) });
  } finally {
    unlisten();
  }
  if (meta.kind !== "export") void useStore.getState().refreshSchema(meta.connId);
  announce(id);
}

/**
 * Runs maintenance SQL (VACUUM, CREATE INDEX, OPTIMIZE…) in the background, one statement at a
 * time (VACUUM and CONCURRENTLY can't run in a transaction block). No dialog opens; the Tasks
 * list shows it and a toast reports the end. Resolves with whether it succeeded.
 */
export async function startSqlJob(meta: { title: string; target: string; connId: string }, statements: string[], onStart?: (jobId: string) => void) {
  const id = crypto.randomUUID();
  const job: ImportJob = { ...meta, id, kind: "sql", workers: 1, fileSize: 0, startedAt: Date.now(), seen: false, statements, done: 0 };
  useImports.setState((s) => ({ jobs: [...s.jobs, job] }));
  onStart?.(id);
  const summary: ImportSummary = { statements: 0, rows: 0, bytes: 0, elapsedMs: 0, cancelled: false, failed: false, errorCount: 0, errors: [], notes: [] };
  let error: string | undefined;
  for (const [i, sql] of statements.entries()) {
    if (useImports.getState().jobs.find((j) => j.id === id)?.stopping) {
      summary.cancelled = true;
      break;
    }
    try {
      const out = await api.runQuery(meta.connId, id, sql, 1000);
      // MySQL OPTIMIZE / ANALYZE TABLE report problems as rows (Msg_type, Msg_text), not errors
      for (const rs of out.resultSets) {
        const type = rs.columns.findIndex((c) => c.name.toLowerCase() === "msg_type");
        const text = rs.columns.findIndex((c) => c.name.toLowerCase() === "msg_text");
        if (type < 0 || text < 0) continue;
        for (const row of rs.rows) {
          const msg = row[text] ?? "";
          if (row[type]?.toLowerCase() === "error") error ??= msg;
          else if (msg && msg !== "OK" && msg !== "Table is already up to date") summary.notes.push(msg);
        }
      }
    } catch (e) {
      error = errorText(e);
    }
    if (error) {
      if (useImports.getState().jobs.find((j) => j.id === id)?.stopping) {
        summary.cancelled = true;
        error = undefined;
      }
      break;
    }
    summary.statements = i + 1;
    patch(id, { done: i + 1 });
  }
  summary.elapsedMs = Date.now() - job.startedAt;
  summary.failed = !!error;
  patch(id, { summary, error });
  void useStore.getState().refreshSchema(meta.connId);
  announce(id);
  return !error && !summary.cancelled;
}

/** Runs `step` for each item as a background task (kind "scan"): progress in Tasks, a toast at the end. */
export async function startScanJob(meta: { title: string; target: string; connId: string }, items: string[], step: (item: string) => Promise<void>, onStart?: (jobId: string) => void) {
  const id = crypto.randomUUID();
  const job: ImportJob = { ...meta, id, kind: "scan", workers: 1, fileSize: 0, startedAt: Date.now(), seen: false, statements: items, done: 0 };
  useImports.setState((s) => ({ jobs: [...s.jobs, job] }));
  onStart?.(id);
  const summary: ImportSummary = { statements: 0, rows: 0, bytes: 0, elapsedMs: 0, cancelled: false, failed: false, errorCount: 0, errors: [], notes: [] };
  let error: string | undefined;
  for (const [i, item] of items.entries()) {
    if (useImports.getState().jobs.find((j) => j.id === id)?.stopping) {
      summary.cancelled = true;
      break;
    }
    try {
      await step(item);
    } catch (e) {
      error = `${item}: ${errorText(e)}`;
      break;
    }
    summary.statements = i + 1;
    patch(id, { done: i + 1 });
  }
  summary.elapsedMs = Date.now() - job.startedAt;
  summary.failed = !!error;
  patch(id, { summary, error });
  announce(id);
  return { error, cancelled: summary.cancelled };
}

/** Toast for work that isn't an import job; success hides itself, errors stay. */
export function pushToast(tone: Toast["tone"], title: string, body: string) {
  const toast: Toast = { id: crypto.randomUUID(), tone, title, body };
  useImports.setState((st) => ({ toasts: [...st.toasts, toast] }));
  if (tone === "ok") setTimeout(() => useImports.getState().closeToast(toast.id), 7000);
  if (!document.hasFocus()) void osNotify(title, body);
}

/** In-app toast when the dialog is closed, plus a system notification when the app is in the background. */
function announce(id: string) {
  const s = useImports.getState();
  const j = s.jobs.find((x) => x.id === id);
  if (!j) return;
  const { tone, title, body } = outcome(j);
  if (s.open === id) {
    patch(id, { seen: true });
  } else {
    const toast: Toast = { id: crypto.randomUUID(), tone, title, body, jobId: id };
    useImports.setState((st) => ({ toasts: [...st.toasts, toast] }));
    // success toasts auto-dismiss, errors stay
    if (tone === "ok") setTimeout(() => useImports.getState().closeToast(toast.id), 7000);
  }
  if (!document.hasFocus()) void osNotify(title, body);
}

export function outcome(j: ImportJob): { tone: Toast["tone"]; title: string; body: string } {
  const s = j.summary;
  const secs = s ? `${(s.elapsedMs / 1000).toFixed(1)} s` : "";
  if (j.kind === "scan") {
    if (j.error) return { tone: "error", title: `Failed: ${j.title}`, body: j.error };
    if (!s) return { tone: "warn", title: j.title, body: "" };
    if (s.cancelled) return { tone: "warn", title: `Stopped: ${j.title}`, body: `${s.statements} of ${j.statements?.length ?? 0} analyzed.` };
    return { tone: "ok", title: `Finished: ${j.title}`, body: `${j.target} · ${secs}` };
  }
  if (j.kind === "sql") {
    if (j.error) return { tone: "error", title: `Failed: ${j.title}`, body: j.error };
    if (!s) return { tone: "warn", title: j.title, body: "" };
    if (s.cancelled) return { tone: "warn", title: `Stopped: ${j.title}`, body: `${s.statements} of ${j.statements?.length ?? 0} statements finished.` };
    return { tone: "ok", title: `Done: ${j.title}`, body: `${j.target} · ${secs}${s.notes[0] ? ` · ${s.notes[0]}` : ""}` };
  }
  if (j.kind === "export") {
    if (j.error || s?.failed) return { tone: "error", title: `Export failed: ${j.title}`, body: j.error ?? s?.errors[0]?.message ?? "" };
    if (!s) return { tone: "warn", title: j.title, body: "" };
    if (s.cancelled) return { tone: "warn", title: `Export stopped: ${j.title}`, body: "The unfinished file was removed." };
    return { tone: "ok", title: `Export finished: ${j.title}`, body: `${s.rows.toLocaleString()} rows to ${j.target} in ${secs}.` };
  }
  if (j.error) return { tone: "error", title: `Import failed: ${j.title}`, body: j.error };
  if (!s) return { tone: "warn", title: j.title, body: "" };
  if (s.cancelled) return { tone: "warn", title: `Import stopped: ${j.title}`, body: `${s.rows.toLocaleString()} rows were imported before it stopped.` };
  if (s.failed) return { tone: "error", title: `Import stopped at an error: ${j.title}`, body: s.errors[0] ? `Line ${s.errors[0].line}: ${s.errors[0].message}` : "See details." };
  if (s.errorCount > 0)
    return { tone: "warn", title: `Import finished with ${s.errorCount} skipped: ${j.title}`, body: `${s.rows.toLocaleString()} rows into ${j.target} in ${secs}.` };
  return { tone: "ok", title: `Import finished: ${j.title}`, body: `${s.rows.toLocaleString()} rows into ${j.target} in ${secs}.` };
}

async function osNotify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body: body.slice(0, 200) });
  } catch {
    // no system notifications outside Tauri
  }
}
