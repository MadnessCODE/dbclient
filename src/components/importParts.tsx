// Shared import wizard parts (dump and table import): steps, progress, workers.
import { Check, CircleAlert, CircleCheck, Info, Lightbulb, OctagonX, Square } from "lucide-react";
import type { ConnectionConfig, ImportProgress, ImportSummary, WorkerView } from "../lib/api";
import { dbOf, isMultiDb, subId } from "../lib/connIds";
import { useStore } from "../store";
import { formatBytes } from "./LeftPanel";
import { cx, Spinner } from "./ui";

/** Worker limit follows the CPU core count (2..16); default 4 or fewer. */
export const CORES = Math.max(1, navigator.hardwareConcurrency || 4);
export const MAX_WORKERS = Math.min(16, Math.max(2, CORES));
export const DEFAULT_WORKERS = Math.min(4, MAX_WORKERS);

export function RunView({
  fileSize,
  progress: p,
  summary,
  error,
  running,
  workers,
  mode = "import",
}: {
  mode?: "import" | "export";
  fileSize: number;
  progress: ImportProgress | null;
  summary: ImportSummary | null;
  error: string | null;
  running: boolean;
  workers: number;
}) {
  const total = p?.totalBytes || fileSize || 0;
  const rowsUnit = p?.unit === "rows";
  const finishedOk = !!summary && !summary.failed && !summary.cancelled;
  const read = finishedOk ? total : (p?.doneBytes ?? 0);
  const pct = total > 0 ? Math.min(100, (read / total) * 100) : 0;
  const secs = (summary?.elapsedMs ?? p?.elapsedMs ?? 0) / 1000;
  const speed = secs > 0 ? read / secs : 0;
  const eta = speed > 0 && running ? (total - read) / speed : 0;

  const rows = summary?.rows ?? p?.rows ?? 0;
  const statements = summary?.statements ?? p?.statements ?? 0;
  const errorCount = summary?.errorCount ?? p?.errorCount ?? 0;

  const Verb = mode === "export" ? "Export" : "Import";
  const status = error
    ? { icon: <OctagonX size={22} className="text-err" />, title: `${Verb} failed`, tone: "text-err" }
    : summary?.cancelled
      ? { icon: <Square size={20} className="text-warn" />, title: `${Verb} stopped`, tone: "text-warn" }
      : summary?.failed
        ? { icon: <CircleAlert size={22} className="text-err" />, title: "Stopped at an error", tone: "text-err" }
        : summary
          ? { icon: <CircleCheck size={22} className="text-ok" />, title: errorCount ? `Done with ${errorCount} skipped statement${errorCount > 1 ? "s" : ""}` : `${Verb} finished`, tone: "text-ok" }
          : { icon: <Spinner size={20} />, title: mode === "export" ? "Exporting…" : "Importing…", tone: "text-fg" };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {status.icon}
        <div className="min-w-0 flex-1">
          <div className={cx("text-[16px] font-semibold", status.tone)}>{status.title}</div>
          <div className="truncate text-[12.5px] text-muted">
            {running ? (p?.table ? (p.table.endsWith("…") ? p.table : `Working on ${p.table}`) : mode === "export" ? "Reading the structure…" : "Reading the file…") : summary ? `${fmtSecs(secs)} total` : error}
          </div>
        </div>
        <div className="text-right font-mono text-[22px] font-semibold tabular-nums text-fg">{Math.floor(pct)}%</div>
      </div>

      <div className="relative h-2.5 overflow-hidden rounded-full bg-hover">
        <div
          className={cx("absolute inset-y-0 left-0 rounded-full transition-[width] duration-300", error || summary?.failed ? "bg-err" : summary?.cancelled ? "bg-warn" : summary ? "bg-ok" : "bg-accent")}
          style={{ width: `${pct}%` }}
        />
        {running && <div className="loading-bar absolute inset-0 opacity-40" />}
      </div>

      <div className="grid grid-cols-5 gap-2">
        <Stat label="Elapsed" value={fmtSecs(secs)} />
        <Stat label="Speed" value={speed > 0 ? (rowsUnit ? `${Math.round(speed).toLocaleString()} rows/s` : `${formatBytes(speed)}/s`) : "—"} />
        <Stat label="Time left" value={running ? (eta > 0 ? `~${fmtSecs(eta)}` : "—") : "—"} />
        <Stat label="Rows" value={rows.toLocaleString()} />
        <Stat label={mode === "export" ? "Tables done" : "Statements"} value={statements.toLocaleString()} />
      </div>

      {p && p.workers.length > 0 && <Lanes workers={p.workers} running={running} total={workers} />}

      {summary?.notes.map((n) => (
        <p key={n} className="flex items-start gap-1.5 text-[12px] text-fg-2">
          <Info size={14} className="mt-px shrink-0 text-accent" /> {n}
        </p>
      ))}

      {(summary?.errors.length ?? 0) > 0 && (
        <div className="flex min-h-0 flex-col gap-1.5">
          <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-muted">
            Errors {summary!.errorCount > summary!.errors.length && `(first ${summary!.errors.length} of ${summary!.errorCount.toLocaleString()})`}
          </h3>
          <div className="selectable max-h-[170px] overflow-auto rounded-lg border border-line bg-bg/60">
            {summary!.errors.map((e, i) => (
              <div key={i} className="border-b border-line px-3 py-2 last:border-0">
                <div className="flex gap-2 text-[12.5px]">
                  <span className="shrink-0 font-mono text-muted">line {e.line}</span>
                  <span className="text-err">{e.message}</span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[11.5px] text-fg-2">{e.sql}</div>
                {errorHint(e.message) && (
                  <div className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug text-fg-2">
                    <Lightbulb size={14} className="mt-px shrink-0 text-warn" />
                    <span>{errorHint(e.message)}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {summary && !summary.failed && !summary.cancelled && errorCount === 0 && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-fg-2">
          <Check size={15} className="text-ok" />{" "}
          {mode === "export" ? `File saved · ${formatBytes(summary.bytes)}` : "All statements ran without errors. The schema tree was refreshed."}
        </p>
      )}
    </div>
  );
}

/** Hint for common dump import errors. */
export function errorHint(message: string): string | null {
  const m = message.toLowerCase();
  if (m.includes("binary logging is enabled"))
    return "The server keeps a binary log, so creating triggers and functions needs admin rights. Import with an admin user, or ask an admin to run SET GLOBAL log_bin_trust_function_creators = 1.";
  if (m.includes("you need (at least one of) the super") || m.includes("set_user_id") || m.includes("system_variables_admin"))
    return "This statement needs admin rights (often a DEFINER or a global SET in the dump). Import with an admin user, or choose “Skip it and continue”.";
  if (m.includes("already exists"))
    return "The object is already in the target database. Import into an empty database, or choose “Skip it and continue”.";
  if (m.includes("must be owner") || m.includes("permission denied"))
    return "Your user doesn't own this object or lacks rights. Import with the owner/admin user, or choose “Skip it and continue”.";
  if (m.includes("doesn't exist") || m.includes("does not exist"))
    return "Something this statement needs is missing. Often the dump expects another database/schema or an earlier part failed.";
  if (m.includes("max_allowed_packet"))
    return "A statement is bigger than the server allows. Raise max_allowed_packet on the server and try again.";
  return null;
}

/** Parallel connections slider, up to the core count. */
export function WorkerSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const pct = ((value - 1) / (MAX_WORKERS - 1)) * 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12.5px] text-fg-2">Parallel connections</span>
        <span className="text-[12px] text-muted">
          <b className="font-mono text-[15px] font-semibold text-fg">{value}</b> / {MAX_WORKERS}
        </span>
      </div>
      <input
        type="range"
        min={1}
        max={MAX_WORKERS}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="range-accent"
        style={{ background: `linear-gradient(to right, var(--accent) ${pct}%, var(--hover) ${pct}%)` }}
      />
      <div className="relative flex h-4 justify-between text-[10.5px] text-muted">
        <span>1</span>
        {DEFAULT_WORKERS > 1 && DEFAULT_WORKERS < MAX_WORKERS && (
          <button
            className="absolute -translate-x-1/2 whitespace-nowrap hover:text-accent"
            style={{ left: `${((DEFAULT_WORKERS - 1) / (MAX_WORKERS - 1)) * 100}%` }}
            onClick={() => onChange(DEFAULT_WORKERS)}
          >
            ▲ {DEFAULT_WORKERS} recommended
          </button>
        )}
        <span>{MAX_WORKERS} max</span>
      </div>
      {value === MAX_WORKERS && (
        <p className="text-[11.5px] leading-snug text-muted">
          {CORES > MAX_WORKERS
            ? `This computer has ${CORES} CPU cores, but more than ${MAX_WORKERS} connections rarely helps and only loads the server.`
            : `One connection per CPU core (${CORES}). More would only load the server.`}
        </p>
      )}
    </div>
  );
}

export const TASK_LABEL: Record<string, string> = { insert: "INSERT", copy: "COPY", index: "INDEX", sql: "SQL" };

/** One lane per connection, animated while busy. */
export function Lanes({ workers, running, total }: { workers: WorkerView[]; running: boolean; total: number }) {
  const busy = workers.slice(1).filter((w) => w.busy).length;
  const two = workers.length > 9;
  if (!running) {
    // after the import: work done per connection
    const par = workers.slice(1);
    const max = Math.max(1, ...par.map((w) => w.jobs));
    return (
      <div className="flex items-center gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2">
        <span className="text-[12px] text-muted">Connections</span>
        <div className="flex h-6 items-end gap-[3px]">
          {par.map((w, i) => (
            <span
              key={i}
              title={`#${i + 1}: ${w.jobs} jobs`}
              className="w-2.5 rounded-sm bg-accent/70"
              style={{ height: `${Math.max(12, (w.jobs / max) * 100)}%` }}
            />
          ))}
        </div>
        <span className="ml-auto text-[12px] tabular-nums text-muted">
          {total} parallel · {par.reduce((a, w) => a + w.jobs, 0).toLocaleString()} data jobs
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-muted">Connections</h3>
        <span className="text-[12px] tabular-nums text-muted">{running ? `${busy} of ${total} working` : `${workers.reduce((a, w) => a + w.jobs, 0).toLocaleString()} jobs done`}</span>
      </div>
      <div className={cx("grid gap-x-4 gap-y-1.5", two && "grid-cols-2")}>
        {workers.map((w, i) => {
          const on = running && w.busy;
          return (
            <div key={i} className="flex items-center gap-2.5 text-[12px]">
              <span className={cx("w-9 shrink-0 font-mono tabular-nums", i === 0 ? "text-violet-300" : "text-muted")}>{i === 0 ? "main" : `#${i}`}</span>
              <div
                className={cx(
                  "relative h-[18px] flex-1 overflow-hidden rounded-md border transition-colors duration-300",
                  on ? (i === 0 ? "lane-on lane-main border-violet-400/50" : "lane-on border-accent/50") : "border-line bg-bg/40",
                )}
              >
                {on && <span className="lane-dot" />}
                <span className={cx("absolute inset-0 flex items-center gap-1.5 px-2 text-[11px]", on ? "text-white" : "text-muted")}>
                  {on ? (
                    <>
                      <b className="font-semibold">{TASK_LABEL[w.task] ?? w.task}</b>
                      <span className="truncate opacity-90">{w.table}</span>
                    </>
                  ) : (
                    <span>{running ? "waiting" : "done"}</span>
                  )}
                </span>
              </div>
              <span className="w-12 shrink-0 text-right font-mono tabular-nums text-muted" title="Jobs finished by this connection">
                {w.jobs.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function fmtSecs(s: number) {
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export const input = "h-8 w-full rounded-md border border-line-strong bg-bg/50 px-2.5 text-[13px] text-fg outline-none focus:border-accent";

export function Steps({ labels, step, locked, onStep, canGo }: { labels: string[]; step: number; locked: boolean; onStep: (i: number) => void; canGo: (i: number) => boolean }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-5 py-3">
      {labels.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          {i > 0 && <div className={cx("h-px w-8", i <= step ? "bg-accent" : "bg-line-strong")} />}
          <button
            disabled={locked || i === step || !canGo(i)}
            onClick={() => onStep(i)}
            className={cx("flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-[12.5px]", i === step ? "bg-accent-soft text-fg" : i < step ? "text-fg-2 enabled:hover:text-fg" : "text-muted")}
          >
            <span
              className={cx(
                "flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
                i < step ? "bg-accent text-white" : i === step ? "border border-accent text-accent" : "border border-line-strong",
              )}
            >
              {i < step ? <Check size={12} /> : i + 1}
            </span>
            {s}
          </button>
        </div>
      ))}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </div>
  );
}

/** Target database on a PostgreSQL server shown with all its databases. */
export function DatabasePicker({ cfg, connId, onChange }: { cfg: ConnectionConfig; connId: string | null; onChange: (id: string) => void }) {
  const databases = useStore((s) => s.conn[cfg.id]?.databases ?? []);
  const status = useStore((s) => (connId ? s.conn[connId]?.status : undefined));
  const db = dbOf(connId) ?? "";
  return (
    <Section title="Database">
      <select
        value={db}
        onChange={(e) => {
          const id = subId(cfg.id, e.target.value);
          onChange(id);
          if (useStore.getState().conn[id]?.status !== "connected") void useStore.getState().connectTo(id);
        }}
        className={input}
      >
        {!db && <option value="">Choose a database…</option>}
        {databases.map((d) => (
          <option key={d.name}>{d.name}</option>
        ))}
      </select>
      {status === "connecting" && (
        <span className="flex items-center gap-2 text-[11.5px] text-muted">
          <Spinner /> Connecting…
        </span>
      )}
    </Section>
  );
}

/** The chosen target is open and, for a multi-database server, a database is picked. */
export const targetReady = (cfg: ConnectionConfig | null, connId: string | null) =>
  !!cfg && !!connId && (!isMultiDb(cfg) || !!dbOf(connId)) && useStore.getState().conn[connId]?.status === "connected";

export function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex gap-2.5 rounded-lg border border-line bg-panel-2 p-3">
      <span className="mt-px text-accent">{icon}</span>
      <span>
        <span className="block font-semibold text-fg">{title}</span>
        <span className="block leading-snug text-muted">{text}</span>
      </span>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="text-[10.5px] uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[14px] font-semibold tabular-nums text-fg">{value}</div>
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button onClick={() => onChange(!checked)} className="mt-1 flex items-start gap-2.5 text-left">
      <span className={cx("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border", checked ? "border-accent bg-accent text-white" : "border-line-strong")}>
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      <span>
        <span className="block text-[13px] text-fg">{label}</span>
        {hint && <span className="block text-[11.5px] leading-snug text-muted">{hint}</span>}
      </span>
    </button>
  );
}
