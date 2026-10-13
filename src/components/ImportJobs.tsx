// Background imports: progress dialog, Tasks rail button and completion toasts.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, CircleCheck, FileUp, ListChecks, Minimize2, Square, TriangleAlert, X } from "lucide-react";
import { api } from "../lib/api";
import { isDone, isRunning, jobPercent, outcome, useImports, type ImportJob } from "../lib/importJobs";
import { useUpdater } from "../lib/updater";
import { RunView } from "./importParts";
import { UpdateToast } from "./UpdateToast";
import { Button, cx, Modal, Spinner } from "./ui";

/** Progress dialog; closing it only hides it, the import keeps running. */
export function ImportJobDialog() {
  const job = useImports((s) => s.jobs.find((j) => j.id === s.open));
  const show = useImports((s) => s.show);
  const dismiss = useImports((s) => s.dismiss);
  if (!job) return null;
  const running = isRunning(job);
  const hide = () => show(null);

  return (
    <Modal title="Import" onClose={hide} width={job.kind === "table" ? 880 : 760}>
      <div className="flex items-center gap-2 border-b border-line px-5 py-2.5 text-[12.5px] text-fg-2">
        <FileUp size={14} className="shrink-0 text-accent" />
        <span className="truncate font-medium text-fg">{job.title}</span>
        <span className="text-muted">→</span>
        <span className="truncate">{job.target}</span>
      </div>
      <div className="h-[460px] overflow-y-auto px-5 py-4">
        <RunView fileSize={job.fileSize} progress={job.progress ?? null} summary={job.summary ?? null} error={job.error ?? null} running={running} workers={job.workers} />
      </div>
      <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
        <span className="text-[12px] text-muted">{running ? "You can keep working — the import runs in the background." : ""}</span>
        <div className="ml-auto flex gap-2">
          {running ? (
            <>
              <Button onClick={hide}>
                <Minimize2 size={14} /> Run in background
              </Button>
              <Button variant="danger" onClick={() => void api.cancelImport(job.id)}>
                <Square size={12} fill="currentColor" /> Stop import
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                hide();
                dismiss(job.id);
              }}
            >
              Close
            </Button>
          )}
        </div>
      </footer>
    </Modal>
  );
}

/** Tasks rail button: ring = overall progress, badge = running jobs. */
export function TasksButton() {
  const jobs = useImports((s) => s.jobs);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  const running = jobs.filter(isRunning);
  const unseen = jobs.filter((j) => isDone(j) && !j.seen);
  const failed = unseen.some((j) => outcome(j).tone === "error");
  const pct = running.length ? running.reduce((a, j) => a + jobPercent(j), 0) / running.length : 0;
  const badge = running.length || unseen.length;
  const R = 15;
  const C = 2 * Math.PI * R;

  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen(!open)}
        title={running.length ? `${running.length} running · ${Math.floor(pct)}%` : "Background tasks"}
        className={cx(
          "flex w-[60px] flex-col items-center gap-1 rounded-lg py-2 text-[11px] transition-colors",
          open ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover hover:text-fg",
        )}
      >
        <span className="relative flex h-[34px] w-[34px] items-center justify-center">
          {running.length > 0 && (
            <svg className="absolute inset-0 -rotate-90" viewBox="0 0 34 34">
              <circle cx="17" cy="17" r={R} fill="none" stroke="var(--hover)" strokeWidth="2.5" />
              <circle
                cx="17"
                cy="17"
                r={R}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - pct / 100)}
                className="transition-[stroke-dashoffset] duration-300"
              />
            </svg>
          )}
          <ListChecks size={18} className={cx(running.length > 0 && "text-accent", open && "text-accent")} />
          {badge > 0 && (
            <span
              className={cx(
                "absolute -right-1 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white",
                failed ? "bg-err" : running.length ? "bg-accent" : "bg-ok",
              )}
            >
              {badge}
            </span>
          )}
        </span>
        Tasks
      </button>
      {open && btn.current && <TasksPanel anchor={btn.current} onClose={() => setOpen(false)} />}
    </>
  );
}

function TasksPanel({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const jobs = useImports((s) => s.jobs);
  const show = useImports((s) => s.show);
  const dismiss = useImports((s) => s.dismiss);
  const clearFinished = useImports((s) => s.clearFinished);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [anchor, onClose]);
  const r = anchor.getBoundingClientRect();
  const list = [...jobs].reverse(); // newest first

  return createPortal(
    <div
      ref={panel}
      style={{ left: r.right + 8, top: r.top, maxHeight: window.innerHeight - r.top - 12 }}
      className="fixed z-[70] flex w-[380px] animate-[tip-in_140ms_ease-out] flex-col rounded-xl border border-line-strong bg-raised shadow-2xl shadow-black/50"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-[13px] font-semibold text-fg">Background tasks</span>
        {jobs.some(isDone) && (
          <button onClick={clearFinished} className="text-[12px] text-muted hover:text-fg">
            Clear finished
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12.5px] leading-relaxed text-muted">
          No background tasks.
          <br />
          Imports run here, so you can keep working while they finish.
        </div>
      ) : (
        <div className="min-h-0 overflow-y-auto p-1.5">
          {list.map((j) => (
            <TaskRow
              key={j.id}
              job={j}
              onOpen={() => {
                onClose();
                show(j.id);
              }}
              onDismiss={() => dismiss(j.id)}
            />
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

function TaskRow({ job: j, onOpen, onDismiss }: { job: ImportJob; onOpen: () => void; onDismiss: () => void }) {
  const done = isDone(j);
  const tone = done ? outcome(j).tone : null;
  const pct = jobPercent(j);
  const rows = j.summary?.rows ?? j.progress?.rows ?? 0;
  const status = !done
    ? `${rows.toLocaleString()} rows · ${Math.floor(pct)}%`
    : j.error
      ? "Failed"
      : j.summary?.cancelled
        ? `Stopped · ${rows.toLocaleString()} rows`
        : j.summary?.failed
          ? "Stopped at an error"
          : `${rows.toLocaleString()} rows · ${((j.summary?.elapsedMs ?? 0) / 1000).toFixed(1)} s`;
  return (
    <div className="group flex items-start gap-3 rounded-lg px-2.5 py-2.5 hover:bg-hover">
      <span className="mt-0.5">
        {!done ? (
          <Spinner size={15} />
        ) : tone === "ok" ? (
          <CircleCheck size={16} className="text-ok" />
        ) : tone === "error" ? (
          <CircleAlert size={16} className="text-err" />
        ) : (
          <TriangleAlert size={16} className="text-warn" />
        )}
      </span>
      <button onClick={onOpen} className="min-w-0 flex-1 text-left" title="Show details">
        <span className="block truncate text-[13px] font-medium text-fg">{j.title}</span>
        <span className="block truncate text-[11.5px] text-muted">→ {j.target}</span>
        {!done && (
          <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-bg">
            <span className="block h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </span>
        )}
        <span className={cx("mt-1 block text-[11.5px] tabular-nums", tone === "error" ? "text-err" : "text-fg-2")}>{status}</span>
      </button>
      {!done ? (
        <button title="Stop import" onClick={() => void api.cancelImport(j.id)} className="rounded p-1 text-muted hover:bg-err/15 hover:text-err">
          <Square size={12} fill="currentColor" />
        </button>
      ) : (
        <button title="Remove from list" onClick={onDismiss} className="rounded p-1 text-muted opacity-0 hover:bg-bg hover:text-fg group-hover:opacity-100">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** Bottom-right toasts for imports that finish while their dialog is hidden. */
export function ImportToasts() {
  const toasts = useImports((s) => s.toasts);
  const close = useImports((s) => s.closeToast);
  const show = useImports((s) => s.show);
  const update = useUpdater((s) => s.prompt || !!s.updatedTo);
  if (toasts.length === 0 && !update) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[90] flex w-[380px] flex-col gap-2.5">
      <UpdateToast />
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "pointer-events-auto flex animate-[tip-in_160ms_ease-out] gap-3 rounded-xl border bg-raised p-3.5 shadow-2xl shadow-black/50",
            t.tone === "error" ? "border-err/50" : t.tone === "warn" ? "border-warn/50" : "border-ok/40",
          )}
        >
          {t.tone === "error" ? (
            <CircleAlert size={20} className="mt-px shrink-0 text-err" />
          ) : t.tone === "warn" ? (
            <TriangleAlert size={20} className="mt-px shrink-0 text-warn" />
          ) : (
            <CircleCheck size={20} className="mt-px shrink-0 text-ok" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-fg">{t.title}</div>
            <div className="mt-0.5 line-clamp-3 text-[12px] leading-snug text-fg-2">{t.body}</div>
            {t.jobId && (
              <button onClick={() => show(t.jobId!)} className="mt-1.5 text-[12px] font-medium text-accent hover:underline">
                View details
              </button>
            )}
          </div>
          <button title="Close" onClick={() => close(t.id)} className="h-6 shrink-0 rounded p-0.5 text-muted hover:bg-hover hover:text-fg">
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
