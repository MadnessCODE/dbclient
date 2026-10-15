// Background imports: jobs outlive the progress dialog, which can be closed and reopened;
// completion or failure is reported with a notification.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { api, errorText, type ImportProgress, type ImportSummary } from "./api";
import { useStore } from "../store";

export interface ImportJob {
  id: string;
  kind: "dump" | "table" | "export";
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
    void api.cancelImport(id);
  },
  clearFinished: () => set((s) => ({ jobs: s.jobs.filter((j) => !isDone(j)) })),
  closeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const isDone = (j: ImportJob) => !!j.summary || !!j.error;
export const isRunning = (j: ImportJob) => !isDone(j);

/** 0..100 */
export function jobPercent(j: ImportJob) {
  if (j.summary && !j.summary.failed && !j.summary.cancelled) return 100;
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
