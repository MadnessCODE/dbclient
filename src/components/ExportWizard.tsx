// Export wizard: format -> data and options -> destination (file or clipboard) with a preview.
import { useEffect, useMemo, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Braces, Check, CircleCheck, ClipboardCopy, Database, DatabaseZap, Square, FileSpreadsheet, FileText, FolderOpen, HardDriveDownload, TriangleAlert } from "lucide-react";
import { api, errorText, type Cell } from "../lib/api";
import { askPath, defaultOptions, exportableQuery, FORMATS, gridViews, render, writeExport, type ExportFormat, type ExportOptions } from "../lib/export";
import { useStore, type ExportJob } from "../store";
import { Button, cx, Modal, Spinner } from "./ui";

const FORMAT_ICONS: Record<ExportFormat, React.ReactNode> = {
  csv: <FileText size={24} />,
  excel: <FileSpreadsheet size={24} />,
  json: <Braces size={24} />,
  sql: <Database size={24} />,
};

const FORMAT_COLORS: Record<ExportFormat, string> = { csv: "#38bdf8", excel: "#22a565", json: "#f5b942", sql: "#8b9dff" };

const STEPS = ["Format", "Data & options", "Output"];
const PREVIEW_ROWS = 20;

export function ExportWizard() {
  const job = useStore((s) => s.exportJob);
  if (!job) return null;
  return <Wizard key={job.rs.rows.length + job.name} job={job} onClose={() => useStore.getState().setUi({ exportJob: null })} />;
}

function Wizard({ job, onClose }: { job: ExportJob; onClose: () => void }) {
  const { rs, kind, name } = job;
  const view = job.tabId ? gridViews.get(job.tabId) : undefined;
  const grid = view && view.rs === rs ? view : undefined;
  const order = grid?.order ?? rs.rows.map((_, i) => i);
  const selected = grid?.selected ?? [];
  const tableName = useMemo(() => {
    const o = rs.columns.find((c) => c.origin)?.origin;
    return o ? `${o.schema}.${o.table}` : name.replace(/\.sql$/, "");
  }, [rs, name]);

  const [step, setStep] = useState(0);
  const [o, setO] = useState<ExportOptions>(() => defaultOptions(rs, tableName));
  const query = useMemo(() => (job.connId ? exportableQuery(job.sql, kind) : null), [job.connId, job.sql, kind]);
  const [scope, setScope] = useState<"loaded" | "selected" | "all">(selected.length > 1 ? "selected" : "loaded");
  const [fetching, setFetching] = useState<{ queryId: string; startedAt: number } | null>(null);
  const [exported, setExported] = useState(0);
  const allSql = query ? (query.unlimited ?? query.sql) : null;
  const onlySelected = scope === "selected";
  const [dest, setDest] = useState<"file" | "clipboard">("file");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ path?: string; bytes?: number } | null>(null);
  const set = (patch: Partial<ExportOptions>) => setO((x) => ({ ...x, ...patch }));

  const rows = useMemo(() => {
    const pick = new Set(selected);
    return (onlySelected ? order.filter((i) => pick.has(i)) : order).map((i) => rs.rows[i]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlySelected, rs.rows]);
  const preview = useMemo(() => (step === 2 && o.format !== "excel" ? render(kind, rs, rows.slice(0, PREVIEW_ROWS), o) : ""), [step, kind, rs, rows, o]);
  const fmt = FORMATS.find((f) => f.key === o.format)!;
  const canNext = step !== 1 || (o.columns.length > 0 && (o.format !== "sql" || o.table.trim() !== ""));

  /** All rows: re-runs the query without the Max rows cap (and the trailing LIMIT if chosen). */
  const fetchAll = async (): Promise<Cell[][]> => {
    const queryId = crypto.randomUUID();
    setFetching({ queryId, startedAt: Date.now() });
    try {
      const out = await api.runQuery(job.connId!, queryId, allSql!, Number.MAX_SAFE_INTEGER);
      const res = out.resultSets.find((x) => x.returnsRows);
      if (!res) throw new Error("The query returned no rows.");
      if (res.columns.length !== rs.columns.length) throw new Error("The query now returns different columns. Run it again and retry the export.");
      return res.rows;
    } finally {
      setFetching(null);
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      // pick the file before running the query
      const path = dest === "file" ? await askPath(name, o.format) : null;
      if (dest === "file" && !path) return;
      const data = scope === "all" ? await fetchAll() : rows;
      setExported(data.length);
      if (path) {
        await writeExport(path, kind, rs, data, o);
        setDone({ path });
      } else {
        const text = render(kind, rs, data, o);
        await navigator.clipboard.writeText(text);
        setDone({ bytes: text.length });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Export data" onClose={onClose} width={760}>
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <div className={cx("h-px w-8", i <= step ? "bg-accent" : "bg-line-strong")} />}
            <button
              disabled={i > step || !!done}
              onClick={() => setStep(i)}
              className={cx("flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-[12.5px]", i === step ? "bg-accent-soft text-fg" : i < step ? "text-fg-2 hover:text-fg" : "text-muted")}
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

      <div className="h-[460px] overflow-y-auto px-5 py-4">
        {fetching ? (
          <Fetching startedAt={fetching.startedAt} onCancel={() => void api.cancelQuery(fetching.queryId)} />
        ) : done ? (
          <Done done={done} fmt={fmt.label} rows={exported} />
        ) : step === 0 ? (
          <div className="grid grid-cols-2 gap-3">
            {FORMATS.map((f) => (
              <button
                key={f.key}
                onClick={() => set({ format: f.key })}
                onDoubleClick={() => {
                  set({ format: f.key });
                  setStep(1);
                }}
                className={cx(
                  "flex flex-col items-start gap-2 rounded-xl border p-5 text-left transition-colors",
                  o.format === f.key ? "border-accent bg-accent-soft" : "border-line-strong bg-panel-2 hover:border-accent/50 hover:bg-hover",
                )}
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-lg" style={{ color: FORMAT_COLORS[f.key], background: `${FORMAT_COLORS[f.key]}1f` }}>
                  {FORMAT_ICONS[f.key]}
                </span>
                <span className="text-[15px] font-semibold text-fg">{f.label}</span>
                <span className="text-[12px] leading-snug text-muted">{f.desc}</span>
              </button>
            ))}
          </div>
        ) : step === 1 ? (
          <div className="grid grid-cols-2 gap-5">
            <div className="flex min-w-0 flex-col gap-4">
              <Section title="Rows">
                <Radio checked={scope === "loaded"} onClick={() => setScope("loaded")} label={`Rows shown in the grid (${rs.rows.length.toLocaleString()})`} />
                {selected.length > 0 ? (
                  <Radio checked={scope === "selected"} onClick={() => setScope("selected")} label={`Only rows selected in the grid (${selected.length.toLocaleString()})`} />
                ) : (
                  grid && <p className="pl-[26px] text-[12px] leading-relaxed text-muted">Tip: select rows in the grid to export only those.</p>
                )}
                {/* only when the grid is truncated (LIMIT or Max rows) */}
                {query && (query.limit || rs.truncated) && (
                  <Radio checked={scope === "all"} onClick={() => setScope("all")} label="All rows from the database" />
                )}
                {scope !== "all" && grid && order.some((v, i) => v !== i) && <p className="mt-1 text-[12px] text-muted">Rows are exported in the current sort order.</p>}
                {scope !== "all" && rs.truncated && (
                  <p className="mt-1 flex items-start gap-1.5 text-[12px] text-warn">
                    <TriangleAlert size={14} className="mt-px shrink-0" />
                    {query ? "The result hit the Max rows limit. Choose “All rows from the database” to get everything." : "The result hit the Max rows limit; only the loaded rows are exported."}
                  </p>
                )}
              </Section>
              <Section
                title={`Columns (${o.columns.length}/${rs.columns.length})`}
                action={
                  <div className="flex gap-2 text-[12px]">
                    <button className="text-accent hover:underline" onClick={() => set({ columns: rs.columns.map((_, i) => i) })}>
                      All
                    </button>
                    <button className="text-accent hover:underline" onClick={() => set({ columns: [] })}>
                      None
                    </button>
                  </div>
                }
              >
                <div className="max-h-[290px] overflow-y-auto rounded-lg border border-line bg-bg/40 p-1">
                  {rs.columns.map((c, i) => {
                    const on = o.columns.includes(i);
                    return (
                      <button
                        key={i}
                        onClick={() => setO((x) => ({ ...x, columns: x.columns.includes(i) ? x.columns.filter((y) => y !== i) : [...x.columns, i].sort((p, q) => p - q) }))}
                        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover"
                      >
                        <CheckBox checked={on} />
                        <span className="truncate text-fg">{c.name}</span>
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">{c.typeName}</span>
                      </button>
                    );
                  })}
                </div>
              </Section>
            </div>
            <Section title={`${fmt.label} options`}>
              <FormatOptions o={o} set={set} />
            </Section>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <DestCard active={dest === "file"} onClick={() => setDest("file")} icon={<HardDriveDownload size={20} />} title="Save to file" desc={`Choose where to save the .${fmt.ext} file`} />
              <DestCard active={dest === "clipboard"} onClick={() => setDest("clipboard")} icon={<ClipboardCopy size={20} />} title="Copy to clipboard" desc={o.format === "excel" ? "Tab separated, pastes straight into Excel" : "Paste it anywhere"} />
            </div>
            <Section title={scope === "all" ? `Preview (first rows; all rows are fetched on export)` : `Preview${rows.length > PREVIEW_ROWS ? ` (first ${PREVIEW_ROWS} of ${rows.length.toLocaleString()} rows)` : ""}`}>
              {o.format === "excel" ? (
                <SheetPreview columns={o.columns.map((i) => rs.columns[i].name)} rows={rows.slice(0, PREVIEW_ROWS).map((r) => o.columns.map((i) => r[i]))} o={o} />
              ) : (
                <pre className="selectable h-[280px] overflow-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-[12px] leading-relaxed text-fg-2">
                  {preview || " "}
                </pre>
              )}
            </Section>
          </div>
        )}
        {error && <p className="mt-3 text-[12.5px] text-err">{error}</p>}
      </div>

      <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
        <span className="text-[12.5px] text-muted">
          {fmt.label} · {scope === "all" ? "all rows" : `${rows.length.toLocaleString()} rows`} · {o.columns.length} columns
        </span>
        <div className="ml-auto flex gap-2">
          {done ? (
            <>
              {done.path && (
                <Button onClick={() => void revealItemInDir(done.path!).catch((e) => setError(errorText(e)))}>
                  <FolderOpen size={15} /> Show in folder
                </Button>
              )}
              <Button variant="primary" onClick={onClose}>
                Close
              </Button>
            </>
          ) : (
            <>
              <Button onClick={step === 0 ? onClose : () => setStep(step - 1)}>{step === 0 ? "Cancel" : "Back"}</Button>
              {step < 2 ? (
                <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
                  Next
                </Button>
              ) : (
                <Button variant="primary" disabled={busy || (scope !== "all" && rows.length === 0)} onClick={() => void run()}>
                  {busy ? <Spinner /> : dest === "file" ? <HardDriveDownload size={15} /> : <ClipboardCopy size={15} />}
                  {dest === "file" ? "Export" : "Copy"}
                </Button>
              )}
            </>
          )}
        </div>
      </footer>
    </Modal>
  );
}

function FormatOptions({ o, set }: { o: ExportOptions; set: (p: Partial<ExportOptions>) => void }) {
  const nullField = (
    <Field label="NULL as">
      <input value={o.nullAs} onChange={(e) => set({ nullAs: e.target.value })} placeholder="(empty)" className={input} />
    </Field>
  );
  switch (o.format) {
    case "excel":
      return (
        <div className="flex flex-col gap-3">
          <Field label="Sheet name">
            <input value={o.sheet} maxLength={31} onChange={(e) => set({ sheet: e.target.value })} className={input} />
          </Field>
          {nullField}
          <Toggle checked={o.header} onChange={(v) => set({ header: v })} label="Header row (bold, frozen, with filters)" />
          <p className="text-[12px] leading-relaxed text-muted">
            Numbers, booleans and dates are written as real Excel values, so you can sum, sort and filter them. Very large integers stay as text to keep every digit.
          </p>
        </div>
      );
    case "csv":
      return (
        <div className="flex flex-col gap-3">
          <Field label="Delimiter">
            <Segmented
              value={o.delimiter}
              onChange={(v) => set({ delimiter: v })}
              options={[
                [",", ", comma"],
                [";", "; semicolon"],
                ["\t", "⇥ tab"],
                ["|", "| pipe"],
              ]}
            />
          </Field>
          {nullField}
          <Field label="Line endings">
            <Segmented
              value={o.crlf ? "crlf" : "lf"}
              onChange={(v) => set({ crlf: v === "crlf" })}
              options={[
                ["crlf", "CRLF (Windows)"],
                ["lf", "LF (Unix)"],
              ]}
            />
          </Field>
          <Toggle checked={o.header} onChange={(v) => set({ header: v })} label="Header row with column names" />
          <Toggle checked={o.quoteAll} onChange={(v) => set({ quoteAll: v })} label="Quote every value" />
          <Toggle checked={o.bom} onChange={(v) => set({ bom: v })} label="UTF-8 BOM (Excel opens accents correctly)" />
        </div>
      );
    case "json":
      return (
        <div className="flex flex-col gap-3">
          <Field label="Style">
            <Segmented
              value={o.jsonStyle}
              onChange={(v) => set({ jsonStyle: v as ExportOptions["jsonStyle"] })}
              options={[
                ["array", "Array of objects"],
                ["lines", "JSON Lines"],
              ]}
            />
          </Field>
          {o.jsonStyle === "array" && <Toggle checked={o.pretty} onChange={(v) => set({ pretty: v })} label="Pretty print (indented)" />}
          <Toggle checked={o.typed} onChange={(v) => set({ typed: v })} label="Numbers, booleans and JSON columns as native JSON values" />
          <p className="text-[12px] text-muted">NULL is always exported as null.</p>
        </div>
      );
    case "sql":
      return (
        <div className="flex flex-col gap-3">
          <Field label="Target table">
            <input value={o.table} onChange={(e) => set({ table: e.target.value })} placeholder="schema.table" className={cx(input, "font-mono")} />
          </Field>
          <Field label="Rows per INSERT">
            <Segmented
              value={String(o.rowsPerInsert)}
              onChange={(v) => set({ rowsPerInsert: Number(v) })}
              options={[
                ["1", "1"],
                ["100", "100"],
                ["500", "500"],
                ["1000", "1000"],
              ]}
            />
          </Field>
          <p className="text-[12px] text-muted">Values are quoted for the current database; NULL stays NULL.</p>
        </div>
      );
  }
}

/** Spreadsheet-style preview. */
function SheetPreview({ columns, rows, o }: { columns: string[]; rows: (string | null)[][]; o: ExportOptions }) {
  const letter = (i: number) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : "") + String.fromCharCode(65 + (i % 26));
  const first = o.header ? 2 : 1;
  return (
    <div className="h-[280px] overflow-auto rounded-lg border border-line bg-bg/60">
      <table className="border-collapse text-[12px]">
        <thead className="sticky top-0 z-10">
          <tr className="bg-panel-2 text-muted">
            <th className="w-9 border border-line px-1 font-normal" />
            {columns.map((_, i) => (
              <th key={i} className="min-w-[90px] border border-line px-2 py-0.5 font-normal">
                {letter(i)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {o.header && (
            <tr>
              <td className="border border-line bg-panel-2 px-1 text-center text-muted">1</td>
              {columns.map((c, i) => (
                <td key={i} className="max-w-[220px] truncate border border-line bg-accent-soft px-2 py-1 font-semibold text-fg">
                  {c}
                </td>
              ))}
            </tr>
          )}
          {rows.map((r, ri) => (
            <tr key={ri}>
              <td className="border border-line bg-panel-2 px-1 text-center text-muted">{ri + first}</td>
              {r.map((v, i) => (
                <td key={i} className={cx("max-w-[220px] truncate border border-line px-2 py-1", v === null ? "italic text-muted" : "text-fg-2")}>
                  {v ?? o.nullAs}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Fetching({ startedAt, onCancel }: { startedAt: number; onCancel: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <DatabaseZap size={40} className="animate-pulse text-accent" />
      <div className="text-[15px] font-semibold text-fg">Fetching all rows from the database…</div>
      <div className="font-mono text-[12.5px] tabular-nums text-muted">{((Date.now() - startedAt) / 1000).toFixed(1)} s</div>
      <button onClick={onCancel} className="mt-1 flex items-center gap-1.5 rounded-md bg-err/15 px-3 py-1.5 text-[12.5px] font-medium text-err hover:bg-err/25">
        <Square size={11} fill="currentColor" /> Cancel
      </button>
    </div>
  );
}

function Done({ done, fmt, rows }: { done: { path?: string; bytes?: number }; fmt: string; rows: number }) {
  const b = done.bytes;
  const size = b === undefined ? "" : b > 1024 * 1024 ? ` · ${(b / 1024 / 1024).toFixed(1)} MB` : ` · ${Math.max(1, Math.round(b / 1024))} KB`;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <CircleCheck size={44} className="text-ok" />
      <div className="text-[16px] font-semibold text-fg">{done.path ? "Export finished" : "Copied to clipboard"}</div>
      <div className="text-[13px] text-fg-2">
        {rows.toLocaleString()} rows as {fmt}
        {size}
      </div>
      {done.path && <div className="selectable max-w-full break-all font-mono text-[12px] text-muted">{done.path}</div>}
    </div>
  );
}

const input = "h-8 w-full rounded-md border border-line-strong bg-bg/50 px-2.5 text-[13px] text-fg outline-none focus:border-accent";

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] text-fg-2">{label}</span>
      {children}
    </div>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cx(
            "h-8 rounded-md border px-3 text-[12.5px]",
            value === v ? "border-accent bg-accent-soft text-fg" : "border-line-strong bg-panel-2 text-fg-2 hover:bg-hover hover:text-fg",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      className={cx("flex h-4 w-4 shrink-0 items-center justify-center rounded border", checked ? "border-accent bg-accent text-white" : "border-line-strong")}
    >
      {checked && <Check size={11} strokeWidth={3} />}
    </span>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex items-center gap-2.5 text-left text-[13px] text-fg-2 hover:text-fg">
      <CheckBox checked={checked} />
      {label}
    </button>
  );
}

function Radio({ checked, disabled, onClick, label }: { checked: boolean; disabled?: boolean; onClick: () => void; label: string }) {
  return (
    <button disabled={disabled} onClick={onClick} className="flex items-center gap-2.5 py-0.5 text-left text-[13px] text-fg-2 enabled:hover:text-fg disabled:opacity-40">
      <span className={cx("flex h-4 w-4 items-center justify-center rounded-full border", checked ? "border-accent" : "border-line-strong")}>
        {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
      {label}
    </button>
  );
}

function DestCard({ active, onClick, icon, title, desc }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; desc: string }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex items-center gap-3 rounded-xl border p-3.5 text-left transition-colors",
        active ? "border-accent bg-accent-soft" : "border-line-strong bg-panel-2 hover:bg-hover",
      )}
    >
      <span className={active ? "text-accent" : "text-fg-2"}>{icon}</span>
      <span>
        <span className="block text-[13.5px] font-semibold text-fg">{title}</span>
        <span className="block text-[12px] text-muted">{desc}</span>
      </span>
    </button>
  );
}
