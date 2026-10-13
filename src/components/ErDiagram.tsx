// ER diagram of a schema: the same self-contained page that "Export HTML" saves, shown in an iframe.
import { useCallback, useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Check, Download, Network, RefreshCw, X } from "lucide-react";
import { api, errorText } from "../lib/api";
import { baseId, dbOf } from "../lib/connIds";
import { buildErHtml, loadErTables, type ErModel } from "../lib/er";
import { useStore } from "../store";
import { Button, IconButton, Spinner } from "./ui";

type ErWindow = Window & { __er?: { positions: () => ErModel["positions"]; theme: () => "dark" | "light" } };

export function ErDiagramHost() {
  const dlg = useStore((s) => s.erDialog);
  if (!dlg) return null;
  return <ErDiagram key={`${dlg.connId}/${dlg.schema}`} connId={dlg.connId} schema={dlg.schema} />;
}

function ErDiagram({ connId, schema }: { connId: string; schema: string }) {
  const cfg = useStore((s) => s.connections.find((c) => c.id === baseId(connId)));
  const theme = useStore((s) => s.theme);
  const [model, setModel] = useState<ErModel | null>(null);
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const close = useCallback(() => useStore.getState().setUi({ erDialog: null }), []);

  const db = dbOf(connId);
  const title = cfg?.kind === "mysql" ? schema : db ? `${db}.${schema}` : schema;
  const subtitle = [cfg?.name, cfg?.kind === "mysql" ? "MySQL" : "PostgreSQL"].filter(Boolean).join(" · ");

  const load = useCallback(async () => {
    setError(null);
    setModel(null);
    try {
      const tables = await loadErTables(connId, schema);
      const m: ErModel = { title, subtitle, schema, kind: cfg?.kind ?? "postgres", theme, tables };
      setModel(m);
      setHtml(buildErHtml({ ...m, embedded: true }));
    } catch (e) {
      setError(errorText(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, schema]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const exportHtml = async () => {
    if (!model) return;
    const win = frame.current?.contentWindow as ErWindow | null | undefined;
    const path = await save({ defaultPath: `${title.replace(/[^\w.-]+/g, "_")}-er.html`, filters: [{ name: "HTML", extensions: ["html"] }] });
    if (!path) return;
    // keep the arrangement and theme from the preview
    const out = buildErHtml({ ...model, positions: win?.__er?.positions(), theme: win?.__er?.theme() ?? model.theme });
    try {
      await api.writeTextFile(path, out);
      setSaved(path);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex bg-black/50 p-4 backdrop-blur-[2px]" onMouseDown={close}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <Network size={18} className="text-accent" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold">ER diagram · {title}</div>
            <div className="truncate text-[11.5px] text-muted">
              {subtitle}
              {model && ` · ${model.tables.length} tables and views`}
            </div>
          </div>
          {saved && (
            <span className="flex max-w-[360px] items-center gap-1.5 truncate text-[12px] text-ok" title={saved}>
              <Check size={14} /> Saved to {saved.split(/[\\/]/).pop()}
            </span>
          )}
          <IconButton title="Reload from the database" onClick={() => void load()}>
            <RefreshCw size={15} />
          </IconButton>
          <Button variant="primary" disabled={!model} onClick={() => void exportHtml()}>
            <Download size={15} /> Export HTML
          </Button>
          <IconButton title="Close (Esc)" onClick={close}>
            <X size={17} />
          </IconButton>
        </header>
        <div className="relative min-h-0 flex-1">
          {error ? (
            <div className="p-6 text-[13px] text-err">{error}</div>
          ) : !model ? (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted">
              <Spinner /> Reading the schema…
            </div>
          ) : (
            <iframe ref={frame} title="ER diagram" srcDoc={html} className="h-full w-full border-0" />
          )}
        </div>
      </div>
    </div>
  );
}
