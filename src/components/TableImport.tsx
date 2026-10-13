// CSV / Excel / JSON import: data -> target -> columns -> import.
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Braces, ChevronDown, ChevronRight, FileSpreadsheet, FileText, FileUp, KeyRound, Table2, TriangleAlert } from "lucide-react";
import {
  api,
  errorText,
  kindLabel,
  type ColumnGuess,
  type DbKind,
  type SourceOptions,
  type SourcePreview,
  type TableFormat,
  type TableStructure,
} from "../lib/api";
import { COMMON_TYPES } from "../lib/alter";
import { isProduction } from "../lib/connStyle";
import { quoteIdent } from "../lib/sql";
import { useStore } from "../store";
import { formatBytes } from "./LeftPanel";
import { DEFAULT_WORKERS, input, Section, Steps, Toggle, WorkerSlider } from "./importParts";
import { startImport } from "../lib/importJobs";
import { Button, cx, DbIcon, EnvBadge, Modal, Spinner } from "./ui";

export interface TableFile {
  path: string;
  name: string;
  size: number;
  format: TableFormat;
}

export const TABLE_STEPS = ["File", "Data", "Target", "Columns", "Import"];

export const FORMAT_INFO: Record<TableFormat, { label: string; icon: React.ReactNode }> = {
  csv: { label: "CSV / text file", icon: <FileText size={40} className="text-sky-400" /> },
  excel: { label: "Excel workbook", icon: <FileSpreadsheet size={40} className="text-emerald-400" /> },
  json: { label: "JSON", icon: <Braces size={40} className="text-amber-400" /> },
};

/** Format by extension; null = SQL dump. */
export function tableFormatOf(name: string): TableFormat | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["csv", "tsv", "txt", "tab"].includes(ext)) return "csv";
  if (["xlsx", "xlsm", "xlsb", "xls", "ods"].includes(ext)) return "excel";
  if (["json", "jsonl", "ndjson"].includes(ext)) return "json";
  return null;
}

/** SQL-friendly identifier: lowercase ASCII, no spaces. */
export function sqlName(raw: string, fallback: string) {
  const map: Record<string, string> = { đ: "dj", č: "c", ć: "c", š: "s", ž: "z" };
  let s = raw
    .toLowerCase()
    .replace(/[đčćšž]/g, (c) => map[c])
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!s) s = fallback;
  if (/^[0-9]/.test(s)) s = `c_${s}`;
  return s.slice(0, 63);
}

/** Column type for a new table, with headroom for rows beyond the sample. */
export function typeFor(kind: DbKind, g: ColumnGuess): string {
  const my = kind === "mysql";
  switch (g.kind) {
    case "int":
      return my ? "int" : "integer";
    case "bigint":
      return "bigint";
    case "decimal":
      return my ? `decimal(${Math.min(65, Math.max(15, g.precision + 4))},${g.scale})` : "numeric";
    case "double":
      return my ? "double" : "double precision";
    case "bool":
      return my ? "tinyint(1)" : "boolean";
    case "date":
      return "date";
    case "datetime":
      return my ? "datetime" : "timestamptz";
    case "json":
      return my ? "json" : "jsonb";
    default:
      return g.maxLen <= 200 ? `varchar(${Math.min(255, Math.max(32, g.maxLen * 2))})` : "text";
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

interface NewCol {
  include: boolean;
  name: string;
  type: string;
  key: boolean;
}

export function TableImport({
  file,
  initialConn,
  initialDb,
  onBack,
  onClose,
}: {
  file: TableFile;
  initialConn: string | null;
  initialDb: string | null;
  onBack: () => void;
  onClose: () => void;
}) {
  const connections = useStore((s) => s.connections);
  const connState = useStore((s) => s.conn);
  const selected = useStore((s) => s.selectedConnId);
  const connected = connections.filter((c) => connState[c.id]?.status === "connected");

  const [step, setStep] = useState(1);

  // source
  const [src, setSrc] = useState<SourceOptions>({ path: file.path, format: file.format, delimiter: "", encoding: "", header: true, sheet: null });
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setPreviewError(null);
    api.previewTableFile(src).then(
      (p) => {
        if (!alive) return;
        setPreview(p);
        setLoading(false);
      },
      (e) => {
        if (!alive) return;
        setPreviewError(errorText(e));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [src]);

  // target
  const [connId, setConnId] = useState<string | null>(() => {
    const pref = initialConn ?? selected;
    return connected.find((c) => c.id === pref)?.id ?? connected[0]?.id ?? null;
  });
  const cfg = connections.find((c) => c.id === connId) ?? null;
  const kind: DbKind = cfg?.kind ?? "postgres";
  const mysql = kind === "mysql";
  const schemas = useMemo(() => (connState[connId ?? ""]?.schema?.schemas ?? []).filter((s) => !s.system), [connState, connId]);
  const [schema, setSchema] = useState(initialDb ?? "");
  useEffect(() => {
    if (schemas.some((s) => s.name === schema)) return;
    const pref = mysql ? cfg?.database : "public";
    setSchema(schemas.find((s) => s.name === pref)?.name ?? schemas[0]?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemas]);
  const tables = schemas.find((s) => s.name === schema)?.tables ?? [];
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [newName, setNewName] = useState(() => sqlName(file.name.replace(/\.[^.]+$/, ""), "imported"));
  const [existing, setExisting] = useState("");
  const [structure, setStructure] = useState<TableStructure | null>(null);
  useEffect(() => {
    if (mode !== "existing" || !connId || !existing) return setStructure(null);
    let alive = true;
    api.getTableStructure(connId, schema, existing).then(
      (s) => alive && setStructure(s),
      () => alive && setStructure(null),
    );
    return () => {
      alive = false;
    };
  }, [mode, connId, schema, existing]);
  const nameTaken = mode === "new" && tables.includes(newName);

  // options
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [truncate, setTruncate] = useState(false);
  const [onConflict, setOnConflict] = useState<"error" | "skip" | "update">("error");
  const [continueOnError, setContinueOnError] = useState(false);
  const [workers, setWorkers] = useState(DEFAULT_WORKERS);
  const [prodOk, setProdOk] = useState(false);

  // columns
  const [cols, setCols] = useState<NewCol[]>([]);
  const [targets, setTargets] = useState<string[]>([]); // existing table: column name or ""
  const colKey = preview?.columns.map((c) => c.name).join("\u0001") ?? "";
  useEffect(() => {
    if (!preview) return;
    const used = new Set<string>();
    setCols(
      preview.columns.map((c, i) => {
        let name = sqlName(c.name, `column_${i + 1}`);
        while (used.has(name)) name = `${name}_${i + 1}`;
        used.add(name);
        return { include: true, name, type: typeFor(kind, c.guess), key: false };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey, kind]);
  useEffect(() => {
    if (!preview || !structure) return setTargets([]);
    const left = new Map(structure.columns.map((c) => [norm(c.name), c.name]));
    setTargets(
      preview.columns.map((c) => {
        const hit = left.get(norm(c.name)) ?? "";
        if (hit) left.delete(norm(c.name));
        return hit;
      }),
    );
  }, [colKey, structure, preview]);

  const mapping = useMemo(
    () =>
      mode === "new"
        ? cols.flatMap((c, i) => (c.include ? [{ source: i, target: c.name.trim() }] : []))
        : targets.flatMap((t, i) => (t ? [{ source: i, target: t }] : [])),
    [mode, cols, targets],
  );
  const keyColumns = mode === "new" ? cols.filter((c) => c.include && c.key).map((c) => c.name) : (structure?.columns.filter((c) => c.primaryKey).map((c) => c.name) ?? []);
  const fullName = schema ? `${quoteIdent(schema, kind)}.${quoteIdent(mode === "new" ? newName : existing, kind)}` : quoteIdent(newName, kind);
  const ddl = useMemo(() => {
    if (mode !== "new") return null;
    const lines = cols.filter((c) => c.include).map((c) => `  ${quoteIdent(c.name, kind)} ${c.type}${c.key ? " NOT NULL" : ""}`);
    if (keyColumns.length) lines.push(`  PRIMARY KEY (${keyColumns.map((k) => quoteIdent(k, kind)).join(", ")})`);
    return `CREATE TABLE ${fullName} (\n${lines.join(",\n")}\n)`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cols, fullName, kind]);
  const before = mode === "new" ? [ddl!] : truncate ? [mysql ? `TRUNCATE TABLE ${fullName}` : `TRUNCATE ${fullName}`] : [];
  const isBool = (t: string) => /^(bool|boolean|tinyint\(1\)|bit\(1\))$/i.test(t.trim());
  const boolColumns =
    mode === "new" ? cols.filter((c) => c.include && isBool(c.type)).map((c) => c.name) : (structure?.columns.filter((c) => isBool(c.columnType)).map((c) => c.name) ?? []);
  const dupNames = mode === "new" && new Set(mapping.map((m) => m.target)).size !== mapping.length;

  // run (in the background)
  const start = () => {
    if (!connId || !preview || !cfg) return;
    const table = mode === "new" ? newName.trim() : existing;
    const options = {
        source: src,
        sourceColumns: preview.columns.map((c) => c.name),
        schema: schema || null,
        table,
        mapping,
        before,
        onConflict,
        keyColumns,
        emptyAsNull,
        boolColumns,
        workers,
        continueOnError,
        database: mysql ? schema || null : null,
    };
    void startImport(
      { kind: "table", title: file.name, target: `${cfg.name} / ${schema}.${table}`, connId, workers, fileSize: file.size },
      (jobId) => api.importTableFile(connId, jobId, options),
    );
    onClose();
  };

  const prod = isProduction(cfg);
  const targetOk = !!cfg && !!schema && (mode === "new" ? !!newName.trim() && !nameTaken : !!existing && !!structure);
  const canGo = (i: number) => {
    if (i <= 1) return true;
    if (i === 2) return !!preview && !previewError;
    if (i === 3) return !!preview && targetOk;
    return false;
  };
  const canStart = targetOk && mapping.length > 0 && !dupNames && (!prod || prodOk) && mapping.every((m) => m.target);

  return (
    <Modal title="Import data" onClose={onClose} width={880}>
      <Steps labels={TABLE_STEPS} step={step} locked={false} onStep={(i) => (i === 0 ? onBack() : setStep(i))} canGo={(i) => i === 0 || canGo(i)} />

      <div className="h-[480px] overflow-y-auto px-5 py-4">
        {step === 1 && (
          <DataStep file={file} src={src} setSrc={setSrc} preview={preview} loading={loading} error={previewError} />
        )}

        {step === 2 && (
          <div className="grid grid-cols-2 gap-6">
            <div className="flex min-w-0 flex-col gap-4">
              <Section title="Import into">
                {connected.length === 0 ? (
                  <p className="text-[13px] text-muted">Connect to a database first, then open Import again.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {connected.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          setConnId(c.id);
                          setProdOk(false);
                          setExisting("");
                        }}
                        className={cx(
                          "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left",
                          c.id === connId ? "border-accent bg-accent-soft" : "border-line-strong bg-panel-2 hover:bg-hover",
                        )}
                      >
                        <DbIcon kind={c.kind} size={18} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-fg">{c.name}</span>
                          <span className="block truncate text-[11.5px] text-muted">{kindLabel(c.kind)}</span>
                        </span>
                        <EnvBadge cfg={c} />
                      </button>
                    ))}
                  </div>
                )}
              </Section>
              {cfg && (
                <Section title={mysql ? "Database" : "Schema"}>
                  <select
                    value={schema}
                    onChange={(e) => {
                      setSchema(e.target.value);
                      setExisting("");
                    }}
                    className={input}
                  >
                    {schemas.map((s) => (
                      <option key={s.name}>{s.name}</option>
                    ))}
                  </select>
                </Section>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <Section title="Table">
                <div className="flex gap-1.5">
                  {(
                    [
                      ["new", "Create a new table"],
                      ["existing", "Existing table"],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => {
                        setMode(v);
                        if (v === "new" && onConflict === "update") setOnConflict("error");
                      }}
                      className={cx(
                        "h-8 flex-1 rounded-md border text-[12.5px]",
                        mode === v ? "border-accent bg-accent-soft text-fg" : "border-line-strong bg-panel-2 text-fg-2 hover:bg-hover hover:text-fg",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {mode === "new" ? (
                  <>
                    <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="table_name" className={cx(input, "font-mono")} />
                    {nameTaken && <p className="text-[12px] text-warn">A table with this name already exists. Pick another name or choose “Existing table”.</p>}
                  </>
                ) : (
                  <select value={existing} onChange={(e) => setExisting(e.target.value)} className={input}>
                    <option value="">Choose a table…</option>
                    {tables.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                )}
                {mode === "existing" && (
                  <Toggle checked={truncate} onChange={setTruncate} label="Empty the table first" hint="Deletes all current rows (TRUNCATE) before importing." />
                )}
              </Section>
              <Section title="Options">
                <WorkerSlider value={workers} onChange={setWorkers} />
                <Toggle checked={emptyAsNull} onChange={setEmptyAsNull} label="Empty values become NULL" hint="Otherwise an empty cell is stored as an empty string." />
                {mode === "existing" && (
                  <>
                    <span className="mt-1 text-[12.5px] text-fg-2">Rows that already exist (same key)</span>
                    <div className="flex gap-1.5">
                      {(
                        [
                          ["error", "Stop"],
                          ["skip", "Skip them"],
                          ["update", "Update them"],
                        ] as const
                      ).map(([v, label]) => (
                        <button
                          key={v}
                          disabled={v === "update" && keyColumns.length === 0}
                          title={v === "update" && keyColumns.length === 0 ? "The table has no primary key" : undefined}
                          onClick={() => setOnConflict(v)}
                          className={cx(
                            "h-8 flex-1 rounded-md border text-[12.5px] disabled:opacity-40",
                            onConflict === v ? "border-accent bg-accent-soft text-fg" : "border-line-strong bg-panel-2 text-fg-2 enabled:hover:bg-hover enabled:hover:text-fg",
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <Toggle checked={continueOnError} onChange={setContinueOnError} label="Skip rows that fail and continue" hint="Bad rows are listed at the end with their row number." />
              </Section>
              {prod && (
                <div className="rounded-lg border border-err/40 bg-err/10 p-3">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-err">
                    <TriangleAlert size={16} /> This is a PRODUCTION database
                  </div>
                  <Toggle checked={prodOk} onChange={setProdOk} label="I understand the import will change production data" />
                </div>
              )}
            </div>
          </div>
        )}

        {step === 3 && preview && (
          <ColumnsStep
            kind={kind}
            mode={mode}
            preview={preview}
            cols={cols}
            setCols={setCols}
            targets={targets}
            setTargets={setTargets}
            structure={structure}
            before={before}
            dupNames={dupNames}
          />
        )}

      </div>

      <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
        <span className="min-w-0 truncate text-[12.5px] text-muted">
          {file.name} · {formatBytes(file.size)}
          {step >= 2 && cfg && ` → ${cfg.name} / ${schema}.${mode === "new" ? newName : existing || "?"}`}
        </span>
        <div className="ml-auto flex shrink-0 gap-2">
          {(
            <>
              <Button onClick={() => (step === 1 ? onBack() : setStep(step - 1))}>Back</Button>
              {step < 3 ? (
                <Button variant="primary" disabled={!canGo(step + 1)} onClick={() => setStep(step + 1)}>
                  Next
                </Button>
              ) : (
                <Button variant="primary" disabled={!canStart} onClick={start}>
                  <FileUp size={15} /> Import {mapping.length} column{mapping.length === 1 ? "" : "s"}
                </Button>
              )}
            </>
          )}
        </div>
      </footer>
    </Modal>
  );
}


const DELIMITERS: [string, string][] = [
  ["", "Auto"],
  [",", ", comma"],
  [";", "; semicolon"],
  ["\\t", "⇥ tab"],
  ["|", "| pipe"],
];

const ENCODINGS: [string, string][] = [
  ["", "Auto"],
  ["utf-8", "UTF-8"],
  ["windows-1250", "Windows-1250 (Central European)"],
  ["windows-1252", "Windows-1252 (Western)"],
  ["windows-1251", "Windows-1251 (Cyrillic)"],
  ["utf-16le", "UTF-16"],
];

function DataStep({
  file,
  src,
  setSrc,
  preview,
  loading,
  error,
}: {
  file: TableFile;
  src: SourceOptions;
  setSrc: (s: SourceOptions) => void;
  preview: SourcePreview | null;
  loading: boolean;
  error: string | null;
}) {
  const set = (patch: Partial<SourceOptions>) => setSrc({ ...src, ...patch });
  const delimLabel = (d: string) => DELIMITERS.find(([v]) => v === d)?.[1].replace(/^. /, "") ?? d;
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        {file.format === "excel" && preview && preview.sheets.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-muted">Sheet</span>
            <select value={preview.sheet ?? ""} onChange={(e) => set({ sheet: e.target.value })} className={cx(input, "w-48")}>
              {preview.sheets.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
        {file.format === "csv" && (
          <div className="flex flex-col gap-1">
            <span className="text-[11.5px] text-muted">Separator {src.delimiter === "" && preview && <span className="text-fg-2">(found: {delimLabel(preview.delimiter)})</span>}</span>
            <div className="flex gap-1">
              {DELIMITERS.map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => set({ delimiter: v })}
                  className={cx(
                    "h-8 rounded-md border px-2.5 text-[12px]",
                    src.delimiter === v ? "border-accent bg-accent-soft text-fg" : "border-line-strong bg-panel-2 text-fg-2 hover:bg-hover hover:text-fg",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {file.format !== "excel" && (
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-muted">
              Encoding {src.encoding === "" && preview && <span className="text-fg-2">(found: {ENCODINGS.find(([v]) => v === preview.encoding)?.[1] ?? preview.encoding})</span>}
            </span>
            <select value={src.encoding} onChange={(e) => set({ encoding: e.target.value })} className={cx(input, "w-56")}>
              {ENCODINGS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        {file.format !== "json" && (
          <div className="pb-1.5">
            <Toggle checked={src.header} onChange={(v) => set({ header: v })} label="First row has column names" />
          </div>
        )}
        {loading && (
          <span className="flex items-center gap-1.5 pb-2 text-[12px] text-muted">
            <Spinner size={12} /> Reading…
          </span>
        )}
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-err/40 bg-err/10 p-3 text-[13px] text-err">
          <TriangleAlert size={16} className="mt-px shrink-0" /> {error}
        </div>
      ) : preview ? (
        <>
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-bg/60">
            <table className="border-collapse text-[12px]">
              <thead className="sticky top-0 z-10 bg-panel-2">
                <tr>
                  {preview.columns.map((c, i) => (
                    <th key={i} className="border-b border-r border-line px-2.5 py-1.5 text-left font-normal">
                      <div className="max-w-[220px] truncate font-semibold text-fg">{c.name}</div>
                      <div className="font-mono text-[10.5px] text-accent">{c.guess.kind}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, ri) => (
                  <tr key={ri} className="hover:bg-hover/50">
                    {preview.columns.map((_, ci) => {
                      const v = r[ci];
                      return (
                        <td key={ci} className={cx("max-w-[220px] truncate border-b border-r border-line px-2.5 py-1", v == null ? "italic text-muted" : "text-fg-2")}>
                          {v == null ? "NULL" : v === "" ? <span className="text-muted">∅</span> : v}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[12px] text-muted">
            {preview.columns.length} columns
            {preview.totalRows != null ? ` · ${preview.totalRows.toLocaleString()} rows` : ""} · showing the first {preview.rows.length} rows. Column types are guessed from up to
            100,000 rows; you can change them in the next steps.
          </p>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted">
          <Spinner />
        </div>
      )}
    </div>
  );
}

function ColumnsStep({
  kind,
  mode,
  preview,
  cols,
  setCols,
  targets,
  setTargets,
  structure,
  before,
  dupNames,
}: {
  kind: DbKind;
  mode: "new" | "existing";
  preview: SourcePreview;
  cols: NewCol[];
  setCols: (c: NewCol[]) => void;
  targets: string[];
  setTargets: (t: string[]) => void;
  structure: TableStructure | null;
  before: string[];
  dupNames: boolean;
}) {
  const [showSql, setShowSql] = useState(false);
  const sample = (i: number) => preview.rows.find((r) => r[i] != null && r[i] !== "")?.[i] ?? null;
  const patch = (i: number, p: Partial<NewCol>) => setCols(cols.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const all = mode === "new" ? cols.every((c) => c.include) : targets.every(Boolean);
  const used = new Set(targets.filter(Boolean));

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="bg-panel-2 text-left text-[11px] uppercase tracking-wider text-muted">
            <tr>
              <th className="w-8 px-2 py-2">
                {mode === "new" && (
                  <input type="checkbox" checked={all} onChange={(e) => setCols(cols.map((c) => ({ ...c, include: e.target.checked })))} className="accent-[var(--accent)]" />
                )}
              </th>
              <th className="px-2 py-2 font-semibold">From file</th>
              <th className="w-6" />
              <th className="px-2 py-2 font-semibold">{mode === "new" ? "Column name" : "Into column"}</th>
              <th className="px-2 py-2 font-semibold">Type</th>
              {mode === "new" && (
                <th className="px-2 py-2 text-center font-semibold" title="Primary key">
                  <KeyRound size={13} className="inline" />
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {preview.columns.map((c, i) => {
              const nc = cols[i];
              const target = targets[i] ?? "";
              const tcol = structure?.columns.find((x) => x.name === target);
              const on = mode === "new" ? nc?.include : !!target;
              return (
                <tr key={i} className={cx("border-t border-line", !on && "opacity-50")}>
                  <td className="px-2 py-1.5 text-center">
                    {mode === "new" && nc && <input type="checkbox" checked={nc.include} onChange={(e) => patch(i, { include: e.target.checked })} className="accent-[var(--accent)]" />}
                  </td>
                  <td className="max-w-[220px] px-2 py-1.5">
                    <div className="truncate font-medium text-fg">{c.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted">{sample(i) ?? "—"}</div>
                  </td>
                  <td className="text-muted">
                    <ArrowRight size={14} />
                  </td>
                  <td className="px-2 py-1.5">
                    {mode === "new" && nc ? (
                      <input value={nc.name} onChange={(e) => patch(i, { name: e.target.value })} className={cx(input, "h-7 font-mono text-[12px]")} />
                    ) : (
                      <select
                        value={target}
                        onChange={(e) => setTargets(targets.map((t, j) => (j === i ? e.target.value : t)))}
                        className={cx(input, "h-7 text-[12px]")}
                      >
                        <option value="">— skip —</option>
                        {structure?.columns.map((sc) => (
                          <option key={sc.name} value={sc.name} disabled={used.has(sc.name) && sc.name !== target}>
                            {sc.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {mode === "new" && nc ? (
                      <>
                        <input list="import-types" value={nc.type} onChange={(e) => patch(i, { type: e.target.value })} className={cx(input, "h-7 font-mono text-[12px]")} />
                      </>
                    ) : (
                      <span className="font-mono text-[12px] text-fg-2">{tcol?.columnType ?? ""}</span>
                    )}
                  </td>
                  {mode === "new" && nc && (
                    <td className="px-2 py-1.5 text-center">
                      <input type="checkbox" checked={nc.key} onChange={(e) => patch(i, { key: e.target.checked })} className="accent-[var(--accent)]" title="Primary key" />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        <datalist id="import-types">
          {COMMON_TYPES[kind].map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>
      {dupNames && <p className="text-[12px] text-err">Two columns have the same name. Rename one of them.</p>}
      {mode === "existing" && structure && (
        <p className="text-[12px] text-muted">
          Columns were matched by name. Table columns left out get their default value
          {structure.columns.filter((c) => !c.nullable && c.default == null && !c.autoIncrement && !targets.includes(c.name)).length > 0 && (
            <span className="text-warn">
              {" "}
              — but{" "}
              {structure.columns
                .filter((c) => !c.nullable && c.default == null && !c.autoIncrement && !targets.includes(c.name))
                .map((c) => c.name)
                .join(", ")}{" "}
              is required and has no default
            </span>
          )}
          .
        </p>
      )}
      {before.length > 0 && (
        <div>
          <button onClick={() => setShowSql(!showSql)} className="flex items-center gap-1 text-[12px] text-accent hover:underline">
            {showSql ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Table2 size={13} /> SQL that runs before the data
          </button>
          {showSql && <pre className="selectable mt-1.5 overflow-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-[12px] text-fg-2">{before.join(";\n\n")};</pre>}
        </div>
      )}
    </div>
  );
}
