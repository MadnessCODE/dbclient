// Import wizard: file -> target and options -> import. SQL dumps run in parallel on the Rust side.
import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileCode2, FileUp, Gauge, OctagonX, ShieldAlert, TriangleAlert, Zap } from "lucide-react";
import { api, errorText, kindLabel, type DumpInfo } from "../lib/api";
import { isProduction } from "../lib/connStyle";
import { useStore } from "../store";
import { formatBytes } from "./LeftPanel";
import { DatabasePicker, DEFAULT_WORKERS, Feature, input, Section, Steps, targetReady, Toggle, WorkerSlider } from "./importParts";
import { startImport } from "../lib/importJobs";
import { Button, cx, DbIcon, EnvBadge, Modal } from "./ui";
import { FORMAT_INFO, TABLE_STEPS, TableImport, tableFormatOf, type TableFile } from "./TableImport";
import { baseId, dbOf, isMultiDb } from "../lib/connIds";

const STEPS = ["File", "Target & options", "Import"];
const DIALECT_LABEL = { mysql: "MySQL / MariaDB dump", postgres: "PostgreSQL dump" } as const;

interface PickedFile extends DumpInfo {
  path: string;
  name: string;
}

export function ImportWizard() {
  const dlg = useStore((s) => s.importDialog);
  if (!dlg) return null;
  return <Wizard initialConn={dlg.connId ?? null} initialDb={dlg.database ?? null} onClose={() => useStore.getState().setUi({ importDialog: null })} />;
}

function Wizard({ initialConn, initialDb, onClose }: { initialConn: string | null; initialDb: string | null; onClose: () => void }) {
  const connections = useStore((s) => s.connections);
  const connState = useStore((s) => s.conn);
  const selected = useStore((s) => s.selectedConnId);
  const connected = connections.filter((c) => connState[c.id]?.status === "connected");

  const [step, setStep] = useState(0);
  const [file, setFile] = useState<PickedFile | null>(null);
  /** CSV / Excel / JSON go to the table import */
  const [tableFile, setTableFile] = useState<TableFile | null>(null);
  const [connId, setConnId] = useState<string | null>(() => {
    const pref = initialConn ?? selected;
    return connected.some((c) => c.id === baseId(pref)) ? pref : (connected[0]?.id ?? null);
  });
  const cfg = connections.find((c) => c.id === baseId(connId)) ?? null;
  const mysql = cfg?.kind === "mysql";
  const databases = useMemo(() => (connState[connId ?? ""]?.schema?.schemas ?? []).filter((s) => !s.system).map((s) => s.name), [connState, connId]);
  const [database, setDatabase] = useState<string>(() => initialDb ?? "");
  const [newDb, setNewDb] = useState(false);
  const [workers, setWorkers] = useState(DEFAULT_WORKERS);
  const [fast, setFast] = useState(true);
  const [continueOnError, setContinueOnError] = useState(false);
  const [stripDefiner, setStripDefiner] = useState(true);
  const [prodOk, setProdOk] = useState(false);

  const [fileError, setFileError] = useState<string | null>(null);

  // MySQL default database: from the menu, then the connection, then the first user database
  useEffect(() => {
    if (!mysql || newDb) return;
    if (!database || !databases.includes(database)) setDatabase(databases.includes(cfg?.database ?? "") ? cfg!.database : (databases[0] ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mysql, databases]);

  const choosePath = async (path: string) => {
    setFileError(null);
    try {
      const info = await api.inspectDump(path);
      const name = path.split(/[\\/]/).pop() ?? path;
      const format = tableFormatOf(name);
      if (format) {
        setFile(null);
        setTableFile({ path, name, size: info.size, format });
      } else {
        setTableFile(null);
        setFile({ ...info, path, name });
      }
    } catch (e) {
      setFileError(errorText(e));
    }
  };

  // dev only: lets automated tests pick a file without the native dialog
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __importTestFile?: (p: string) => Promise<void> };
    w.__importTestFile = choosePath;
    return () => void delete w.__importTestFile;
  });

  const pick = async () => {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "All supported", extensions: ["sql", "gz", "dump", "csv", "tsv", "txt", "xlsx", "xlsm", "xls", "ods", "json", "jsonl", "ndjson"] },
        { name: "SQL dump", extensions: ["sql", "gz", "dump"] },
        { name: "CSV / text", extensions: ["csv", "tsv", "txt"] },
        { name: "Excel", extensions: ["xlsx", "xlsm", "xls", "ods"] },
        { name: "JSON", extensions: ["json", "jsonl", "ndjson"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof path === "string") await choosePath(path);
  };

  /** Runs in the background; the wizard closes and the progress dialog takes over. */
  const start = () => {
    if (!file || !connId || !cfg) return;
    const options = {
      path: file.path,
      workers,
      fast,
      continueOnError,
      database: mysql ? database.trim() || null : null,
      createDatabase: mysql && newDb,
      stripDefiner: mysql && stripDefiner,
    };
    void startImport(
      { kind: "dump", title: file.name, target: `${cfg.name}${mysql && database ? ` / ${database}` : dbOf(connId) ? ` / ${dbOf(connId)}` : ""}`, connId, workers, fileSize: file.size },
      (jobId) => api.importDump(connId, jobId, options),
    );
    onClose();
  };

  const prod = isProduction(cfg);
  const canStart = !!file && targetReady(cfg, connId) && (!mysql || database.trim() !== "") && (!prod || prodOk);

  if (tableFile && step > 0) {
    return <TableImport file={tableFile} initialConn={initialConn ?? connId} initialDb={initialDb} onBack={() => setStep(0)} onClose={onClose} />;
  }

  return (
    <Modal title="Import data" onClose={onClose} width={tableFile ? 880 : 760}>
      <Steps
        labels={tableFile ? TABLE_STEPS : STEPS}
        step={step}
        locked={false}
        onStep={setStep}
        canGo={(i) => (tableFile ? i === 1 : i < 2 && (i === 0 || !!file?.text))}
      />

      <div className="h-[460px] overflow-y-auto px-5 py-4">
        {step === 0 && (
          <div className="flex h-full flex-col gap-4">
            <button
              onClick={() => void pick()}
              className={cx(
                "flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 text-center transition-colors",
                file && !file.text ? "border-err/50 bg-err/5" : file || tableFile ? "border-accent/50 bg-accent-soft/40" : "border-line-strong hover:border-accent/60 hover:bg-hover",
              )}
            >
              {tableFile ? (
                <>
                  {FORMAT_INFO[tableFile.format].icon}
                  <div className="text-[16px] font-semibold text-fg">{tableFile.name}</div>
                  <div className="text-[13px] text-fg-2">
                    {formatBytes(tableFile.size)} · {FORMAT_INFO[tableFile.format].label}
                  </div>
                  <span className="rounded-full border border-line-strong bg-panel-2 px-2.5 py-0.5 text-[12px] text-fg-2">Imports into a new or existing table</span>
                  <div className="text-[12px] text-accent">Click to choose another file</div>
                </>
              ) : file && !file.text ? (
                <>
                  <OctagonX size={40} className="text-err" />
                  <div className="text-[16px] font-semibold text-fg">{file.name}</div>
                  <div className="max-w-[460px] text-[13px] leading-relaxed text-fg-2">
                    {file.detected === "pg_dump custom/directory format" ? (
                      <>
                        This is a <b className="text-fg">pg_dump custom format</b> file. Make the dump in plain SQL format instead:{" "}
                        <code className="text-fg">pg_dump --format=plain mydb &gt; dump.sql</code>
                      </>
                    ) : (
                      <>
                        This doesn&apos;t look like an SQL file
                        {file.detected ? (
                          <>
                            {" "}
                            — it&apos;s a <b className="text-fg">{file.detected}</b>
                          </>
                        ) : (
                          " (it contains binary data)"
                        )}
                        . Choose a .sql or .sql.gz dump.
                      </>
                    )}
                  </div>
                  <div className="text-[12px] text-accent">Click to choose another file</div>
                </>
              ) : file ? (
                <>
                  <FileCode2 size={40} className="text-accent" />
                  <div className="text-[16px] font-semibold text-fg">{file.name}</div>
                  <div className="text-[13px] text-fg-2">
                    {formatBytes(file.size)} · {file.gzip ? "gzip compressed" : "plain text"}
                  </div>
                  <span className="rounded-full border border-line-strong bg-panel-2 px-2.5 py-0.5 text-[12px] text-fg-2">
                    {file.dialect ? `Looks like a ${DIALECT_LABEL[file.dialect]}` : "SQL script"}
                  </span>
                  <div className="text-[12px] text-accent">Click to choose another file</div>
                </>
              ) : (
                <>
                  <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                    <FileUp size={28} />
                  </span>
                  <div className="text-[16px] font-semibold text-fg">Choose a file to import</div>
                  <div className="max-w-[460px] text-[13px] leading-relaxed text-muted">
                    <b className="font-medium text-fg-2">SQL dumps</b> from mysqldump or pg_dump (also <code>.sql.gz</code>), or data files —{" "}
                    <b className="font-medium text-fg-2">CSV</b>, <b className="font-medium text-fg-2">Excel</b> and <b className="font-medium text-fg-2">JSON</b> — into a new or existing table.
                  </div>
                </>
              )}
            </button>
            {fileError && <p className="text-[12.5px] text-err">{fileError}</p>}
            <div className="grid grid-cols-3 gap-3 text-[12px]">
              <Feature icon={<Zap size={15} />} title="Parallel" text="Inserts run on several connections at once" />
              <Feature icon={<Gauge size={15} />} title="Streaming" text="Gigabyte files without loading them into memory" />
              <Feature icon={<ShieldAlert size={15} />} title="Safe order" text="Tables, data, indexes and keys stay in order" />
            </div>
          </div>
        )}

        {step === 1 && (
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
                        }}
                        className={cx(
                          "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left",
                          c.id === baseId(connId) ? "border-accent bg-accent-soft" : "border-line-strong bg-panel-2 hover:bg-hover",
                        )}
                      >
                        <DbIcon kind={c.kind} size={18} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-fg">{c.name}</span>
                          <span className="block truncate text-[11.5px] text-muted">
                            {kindLabel(c.kind)} · {connState[c.id]?.info?.database || c.database || c.host}
                          </span>
                        </span>
                        <EnvBadge cfg={c} />
                      </button>
                    ))}
                  </div>
                )}
              </Section>
              {cfg && mysql && (
                <Section title="Database">
                  {newDb ? (
                    <input autoFocus value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="new_database" className={input} />
                  ) : (
                    <select value={database} onChange={(e) => setDatabase(e.target.value)} className={input}>
                      {databases.map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                  )}
                  <button
                    className="self-start text-[12px] text-accent hover:underline"
                    onClick={() => {
                      setNewDb(!newDb);
                      setDatabase(newDb ? (databases[0] ?? "") : "");
                    }}
                  >
                    {newDb ? "Pick an existing database" : "+ Create a new database"}
                  </button>
                  <p className="text-[11.5px] leading-snug text-muted">If the dump has its own USE / CREATE DATABASE statements, those are followed.</p>
                </Section>
              )}
              {cfg && isMultiDb(cfg) && <DatabasePicker cfg={cfg} connId={connId} onChange={setConnId} />}
              {cfg && !mysql && !isMultiDb(cfg) && (
                <Section title="Database">
                  <p className="text-[13px] text-fg-2">
                    <b className="font-medium text-fg">{connState[cfg.id]?.info?.database || cfg.database}</b>
                    <span className="text-muted"> — schemas come from the dump itself.</span>
                  </p>
                </Section>
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              <Section title="Speed">
                <WorkerSlider value={workers} onChange={setWorkers} />
                <Toggle
                  checked={fast}
                  onChange={setFast}
                  label="Pause foreign key checks while loading"
                  hint="Foreign keys are still created exactly as in the dump; only the checking is paused, so tables can load in any order and in parallel. Much faster."
                />
                {mysql && (
                  <Toggle
                    checked={stripDefiner}
                    onChange={setStripDefiner}
                    label="Remove DEFINER from views, triggers and routines"
                    hint="Dumps made by another user (often root) fail without admin rights. Objects will belong to your user instead."
                  />
                )}
              </Section>
              <Section title="If a statement fails">
                <div className="flex gap-1.5">
                  {[
                    [false, "Stop the import"],
                    [true, "Skip it and continue"],
                  ].map(([v, label]) => (
                    <button
                      key={String(v)}
                      onClick={() => setContinueOnError(v as boolean)}
                      className={cx(
                        "h-8 flex-1 rounded-md border text-[12.5px]",
                        continueOnError === v ? "border-accent bg-accent-soft text-fg" : "border-line-strong bg-panel-2 text-fg-2 hover:bg-hover hover:text-fg",
                      )}
                    >
                      {label as string}
                    </button>
                  ))}
                </div>
                <p className="text-[11.5px] leading-snug text-muted">Failed statements are listed at the end with their line number.</p>
              </Section>
              {cfg && file?.dialect && file.dialect !== cfg.kind && (
                <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-[12.5px] leading-snug text-fg-2">
                  <TriangleAlert size={16} className="mt-px shrink-0 text-warn" />
                  <span>
                    This file looks like a <b className="text-fg">{DIALECT_LABEL[file.dialect]}</b>, but you are importing into <b className="text-fg">{kindLabel(cfg.kind)}</b>. It will most likely fail.
                  </span>
                </div>
              )}
              {prod && (
                <div className="rounded-lg border border-err/40 bg-err/10 p-3">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-err">
                    <TriangleAlert size={16} /> This is a PRODUCTION database
                  </div>
                  <Toggle checked={prodOk} onChange={setProdOk} label="I understand the dump will change production data" />
                </div>
              )}
            </div>
          </div>
        )}

      </div>

      <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
        <span className="min-w-0 truncate text-[12.5px] text-muted">
          {file ? `${file.name} · ${formatBytes(file.size)}` : tableFile ? `${tableFile.name} · ${formatBytes(tableFile.size)}` : "No file chosen"}
          {cfg && step > 0 && ` → ${cfg.name}${mysql && database ? ` / ${database}` : ""}`}
        </span>
        <div className="ml-auto flex shrink-0 gap-2">
          {(
            <>
              <Button onClick={step === 0 ? onClose : () => setStep(step - 1)}>{step === 0 ? "Cancel" : "Back"}</Button>
              {step === 0 ? (
                <Button variant="primary" disabled={!file?.text && !tableFile} onClick={() => setStep(1)}>
                  Next
                </Button>
              ) : (
                <Button variant="primary" disabled={!canStart} onClick={start}>
                  <FileUp size={15} /> Start import
                </Button>
              )}
            </>
          )}
        </div>
      </footer>
    </Modal>
  );
}
