// Export a whole database or schema into one .sql / .sql.gz file, in the background.
import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { DatabaseBackup, Info } from "lucide-react";
import { api, type ExportOptions } from "../lib/api";
import { baseId, dbOf } from "../lib/connIds";
import { isProduction } from "../lib/connStyle";
import { startImport } from "../lib/importJobs";
import { useStore } from "../store";
import { DEFAULT_WORKERS, Section, Toggle, WorkerSlider } from "./importParts";
import { Button, cx, Modal, Spinner } from "./ui";

type Content = "all" | "structure" | "data";

export function ExportDatabaseHost() {
  const dlg = useStore((s) => s.dbExport);
  if (!dlg) return null;
  return <ExportDatabase key={dlg.connId + (dlg.schema ?? "")} connId={dlg.connId} schema={dlg.schema} />;
}

function ExportDatabase({ connId, schema }: { connId: string; schema?: string }) {
  const cfg = useStore((s) => s.connections.find((c) => c.id === baseId(connId)));
  const state = useStore((s) => s.conn[connId]);
  const close = () => useStore.getState().setUi({ dbExport: null });
  const mysql = cfg?.kind === "mysql";

  useEffect(() => {
    if (state?.status !== "connected") void useStore.getState().connectTo(connId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const userSchemas = useMemo(() => (state?.schema?.schemas ?? []).filter((s) => !s.system).map((s) => s.name), [state?.schema]);
  const [picked, setPicked] = useState<string[] | null>(schema ? [schema] : null);
  const schemas = picked ?? userSchemas;
  const [content, setContent] = useState<Content>("all");
  const [workers, setWorkers] = useState(DEFAULT_WORKERS);
  const [gzip, setGzip] = useState(true);
  const [drop, setDrop] = useState(false);
  const [consistent, setConsistent] = useState(true);

  const dbName = mysql ? (schema ?? "") : (dbOf(connId) ?? state?.info?.database ?? cfg?.database ?? "");
  const label = mysql ? dbName : schema ? `${dbName}.${schema}` : dbName;
  const ready = state?.status === "connected" && !!state.schema && schemas.length > 0;

  const start = async () => {
    if (!cfg) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await save({
      defaultPath: `${label.replace(/[^\w.-]+/g, "_")}-${stamp}.sql${gzip ? ".gz" : ""}`,
      filters: gzip ? [{ name: "Compressed SQL", extensions: ["gz"] }] : [{ name: "SQL", extensions: ["sql"] }],
    });
    if (!path) return;
    const options: ExportOptions = {
      schemas,
      path,
      structure: content !== "data",
      data: content !== "structure",
      dropExisting: drop,
      workers,
      gzip,
      consistent,
    };
    close();
    void startImport(
      { kind: "export", title: label, target: path.split(/[\\/]/).pop() ?? path, connId, workers, fileSize: 0 },
      (jobId) => api.exportDatabase(connId, jobId, options),
    );
  };

  return (
    <Modal title={mysql || !schema ? "Export database" : "Export schema"} onClose={close} width={640}>
      <div className="flex items-center gap-2 border-b border-line px-5 py-2.5 text-[12.5px] text-fg-2">
        <DatabaseBackup size={14} className="shrink-0 text-accent" />
        <span className="truncate font-medium text-fg">{cfg?.name}</span>
        <span className="text-muted">/</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="flex flex-col gap-5 px-5 py-4">
        {!ready && state?.status !== "connected" ? (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <Spinner /> Connecting…
          </div>
        ) : (
          <>
            {!mysql && !schema && (
              <Section title="Schemas">
                {userSchemas.length === 0 ? (
                  <p className="text-[13px] text-muted">{state?.schema ? "This database has no schemas of its own." : "Loading…"}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {userSchemas.map((s) => {
                      const on = schemas.includes(s);
                      return (
                        <button
                          key={s}
                          onClick={() => setPicked(on ? schemas.filter((x) => x !== s) : [...schemas, s])}
                          className={cx("rounded-md border px-2.5 py-1 text-[12.5px]", on ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-muted hover:text-fg")}
                        >
                          {s}
                        </button>
                      );
                    })}
                  </div>
                )}
              </Section>
            )}

            <Section title="What to export">
              <div className="flex gap-1.5">
                {(
                  [
                    ["all", "Structure and data"],
                    ["structure", "Structure only"],
                    ["data", "Data only"],
                  ] as const
                ).map(([v, l]) => (
                  <button
                    key={v}
                    onClick={() => setContent(v)}
                    className={cx("flex-1 rounded-lg border px-3 py-2 text-[13px]", content === v ? "border-accent bg-accent-soft font-medium text-fg" : "border-line-strong text-fg-2 hover:bg-hover")}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <p className="text-[11.5px] leading-snug text-muted">
                {mysql ? "Tables, views, routines and triggers." : "Tables, types, sequences, functions, views, triggers, indexes, constraints and comments."} Owners and grants are not
                included.
              </p>
            </Section>

            {content !== "structure" && (
              <Section title="Speed">
                <WorkerSlider value={workers} onChange={setWorkers} />
                <p className="text-[11.5px] leading-snug text-muted">
                  Tables are read in parallel, big ones in ranges of their primary key, all from the same moment of the database.
                  {isProduction(cfg) && " On production, fewer connections put less load on the server."}
                </p>
              </Section>
            )}

            <Section title="Options">
              <Toggle checked={gzip} onChange={setGzip} label="Compress (.sql.gz)" hint="About 3× smaller; our import, gunzip and zcat read it directly." />
              <Toggle checked={drop} onChange={setDrop} label="Add DROP statements" hint="Replaces existing objects when the file is loaded." />
              {mysql && content !== "structure" && workers > 1 && (
                <Toggle
                  checked={consistent}
                  onChange={setConsistent}
                  label="Same moment for every table"
                  hint="Locks the database for writes for a split second at the start (needs the RELOAD privilege)."
                />
              )}
            </Section>

            {!mysql && (
              <p className="flex items-start gap-1.5 text-[12px] text-fg-2">
                <Info size={14} className="mt-px shrink-0 text-accent" />
                The file loads with our Import, psql or any SQL tool. Extensions it uses are created if missing.
              </p>
            )}
          </>
        )}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!ready} onClick={() => void start()}>
          Export…
        </Button>
      </footer>
    </Modal>
  );
}
