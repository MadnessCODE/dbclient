import { useEffect, useRef, useState } from "react";
import { History, Star, CircleAlert, CircleCheck, TableProperties, Download, Info, ListTree, Maximize2, Minimize2, MessageSquare, Sheet, Square } from "lucide-react";
import type { ResultSet } from "../lib/api";
import { useActiveTab, useStore, type ResultTab, type TabRuntime } from "../store";
import { Button, cx, IconButton, Spinner, MOD } from "./ui";
import { StructurePanel } from "./StructurePanel";
import { DataGrid } from "./DataGrid";
import { HistoryView } from "./HistoryView";
import { FavoritesView } from "./FavoritesView";
import { baseId } from "../lib/connIds";

export function ResultsPanel({ height }: { height?: number }) {
  const tab = useActiveTab();
  const rt = useStore((s) => (tab ? s.runtime[tab.id] : undefined));
  const maximized = useStore((s) => s.resultsMaximized);
  const connections = useStore((s) => s.connections);
  const { patchRuntime, setUi } = useStore.getState();
  if (!tab) return null;

  const resultTab: ResultTab = rt?.resultTab ?? "results";
  const sets = rt?.output?.resultSets ?? [];
  const rs = sets[rt?.activeSet ?? 0];
  const kind = connections.find((c) => c.id === baseId(tab.connId))?.kind ?? "postgres";

  const openExport = () => rs && setUi({ exportJob: { rs, name: tab.title, kind, tabId: tab.id, connId: tab.connId, sql: rt?.lastSql } });

  return (
    <div style={maximized ? undefined : { height }} className={cx("relative mx-3 mb-3 flex shrink-0 flex-col overflow-hidden rounded-lg border border-line-strong bg-panel-2", maximized && "min-h-0 flex-1 mt-3")}>
      {rt?.running && <div className="loading-bar absolute inset-x-0 top-0 z-30 h-[3px]" />}
      <div className="flex h-12 shrink-0 items-end gap-1 border-b border-line px-1.5">
        <ResultTabButton active={resultTab === "results"} onClick={() => patchRuntime(tab.id, { resultTab: "results" })} icon={<Sheet size={16} />} label="Results" />
        <ResultTabButton active={resultTab === "structure"} onClick={() => patchRuntime(tab.id, { resultTab: "structure" })} icon={<TableProperties size={16} />} label="Structure" />
        <ResultTabButton
          active={resultTab === "messages"}
          onClick={() => patchRuntime(tab.id, { resultTab: "messages" })}
          icon={<MessageSquare size={16} />}
          label="Messages"
        />
        <ResultTabButton
          active={resultTab === "history"}
          onClick={() => patchRuntime(tab.id, { resultTab: "history" })}
          icon={<History size={16} />}
          label="History"
        />
        <ResultTabButton
          active={resultTab === "favorites"}
          onClick={() => patchRuntime(tab.id, { resultTab: "favorites" })}
          icon={<Star size={16} />}
          label="Favorites"
        />
        <ResultTabButton active={resultTab === "explain"} onClick={() => patchRuntime(tab.id, { resultTab: "explain" })} icon={<ListTree size={16} />} label="Explain Plan" />
      </div>

      {resultTab === "results" && (
        <>
          <div className="flex h-12 shrink-0 items-center gap-3 px-3.5">
            <StatusLine rt={rt} rs={rs} />
            {sets.length > 1 && (
              <div className="flex items-center gap-1">
                {sets.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => patchRuntime(tab.id, { activeSet: i })}
                    className={cx("rounded px-2 py-0.5 text-[11px]", i === rt?.activeSet ? "bg-accent text-white" : "bg-hover text-fg-2 hover:text-fg")}
                    title={s.returnsRows ? `${s.rows.length} rows` : `${s.rowsAffected} affected`}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button className="h-8" disabled={!rs?.returnsRows} onClick={openExport} title="Export to CSV, JSON, SQL, Markdown…">
                <Download size={15} /> Export
              </Button>
              <IconButton title={maximized ? "Restore" : "Maximize results"} onClick={() => setUi({ resultsMaximized: !maximized })} className="h-8 w-8 border border-line-strong">
                {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </IconButton>
            </div>
          </div>
          {rs?.returnsRows ? (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <div className={cx("flex min-h-0 flex-1 flex-col transition-opacity", rt?.running && "pointer-events-none opacity-30")}>
                <DataGrid key={`${rt?.queryId}-${rt?.activeSet}`} rs={rs} connId={tab.connId} kind={kind} tabId={tab.id} />
              </div>
              {rt?.running && <RunningOverlay rt={rt} tabId={tab.id} />}
            </div>
          ) : rt?.running ? (
            <div className="relative flex flex-1">
              <RunningOverlay rt={rt} tabId={tab.id} />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted">
              {rt?.running ? "Running…" : rs ? `${rs.rowsAffected.toLocaleString()} rows affected` : `Run a query to see results (${MOD}+Enter)`}
            </div>
          )}
        </>
      )}

      {resultTab === "structure" && <StructurePanel tab={tab} />}
      {resultTab === "messages" && <Messages rt={rt} />}
      {resultTab === "history" && <HistoryView tab={tab} />}
      {resultTab === "favorites" && <FavoritesView tab={tab} />}
      {resultTab === "explain" && (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {rt?.explaining ? (
            <div className="flex items-center gap-2 text-muted">
              <Spinner /> Explaining…
            </div>
          ) : rt?.explain ? (
            <pre className="selectable font-mono text-[12.5px] leading-relaxed text-fg-2">{rt.explain}</pre>
          ) : (
            <p className="text-muted">Click “Explain” ({MOD}+E) to see how the database will execute the current statement.</p>
          )}
        </div>
      )}
    </div>
  );
}

function ResultTabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "relative flex h-10 items-center gap-2 rounded-t-md px-4 text-[13px]",
        active ? "bg-accent-soft text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-accent" : "text-fg-2 hover:text-fg",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** Elapsed seconds, updated 10x per second while running. */
function useElapsed(rt?: TabRuntime) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!rt?.running) return;
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [rt?.running]);
  return ((Date.now() - (rt?.startedAt ?? Date.now())) / 1000).toFixed(1);
}

/** Overlay on the previous result while a query runs. */
function RunningOverlay({ rt, tabId }: { rt: TabRuntime; tabId: string }) {
  const secs = useElapsed(rt);
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center">
      <div className="flex items-center gap-3 rounded-xl border border-line-strong bg-raised/95 px-5 py-3.5 shadow-2xl">
        <Spinner size={18} />
        <div>
          <div className="text-[14px] font-medium text-fg">Running query…</div>
          <div className="font-mono text-[12px] text-muted tabular-nums">{secs} s</div>
        </div>
        <button
          onClick={() => void useStore.getState().cancelTab(tabId)}
          className="ml-3 flex items-center gap-1.5 rounded-md bg-err/15 px-3 py-1.5 text-[12.5px] font-medium text-err hover:bg-err/25"
        >
          <Square size={11} fill="currentColor" /> Cancel
        </button>
      </div>
    </div>
  );
}

function StatusLine({ rt, rs }: { rt?: TabRuntime; rs?: ResultSet }) {
  const tabId = useStore((s) => s.activeTabId);
  const secs = useElapsed(rt);

  if (rt?.running) {
    return (
      <div className="flex items-center gap-2.5 text-[13px] text-fg-2">
        <Spinner /> Running… {secs} s
        <button onClick={() => tabId && void useStore.getState().cancelTab(tabId)} className="flex items-center gap-1 text-err hover:underline">
          <Square size={11} fill="currentColor" /> Cancel
        </button>
      </div>
    );
  }
  if (rt?.error) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-[13px] text-err">
        <CircleAlert size={17} className="shrink-0" />
        <span className="truncate" title={rt.error}>{rt.error}</span>
      </div>
    );
  }
  if (!rs || !rt?.output) return <div className="text-[13px] text-muted">No results yet</div>;
  const ms = Math.round(rt.output.elapsedMs);
  return (
    <div className="flex items-center gap-2 text-[13px] text-fg-2">
      <CircleCheck size={18} className="text-ok" />
      {rs.returnsRows ? (
        <span>
          {rs.rows.length.toLocaleString()} rows returned in {ms} ms
          {rs.truncated && <span className="ml-1.5 text-warn">(limit reached — more rows exist)</span>}
        </span>
      ) : (
        <span>
          {rs.rowsAffected.toLocaleString()} rows affected in {ms} ms
        </span>
      )}
    </div>
  );
}

function Messages({ rt }: { rt?: TabRuntime }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView();
  }, [rt?.messages.length]);
  if (!rt?.messages.length) return <div className="p-4 text-muted">No messages.</div>;
  return (
    <div className="selectable min-h-0 flex-1 overflow-auto p-3 font-mono text-[12.5px]">
      {rt.messages.map((m, i) => (
        <div key={i} className="flex gap-3 py-0.5">
          <span className="shrink-0 text-muted">{new Date(m.at).toLocaleTimeString()}</span>
          {m.kind === "error" ? <CircleAlert size={15} className="mt-0.5 shrink-0 text-err" /> : m.kind === "ok" ? <CircleCheck size={15} className="mt-0.5 shrink-0 text-ok" /> : <Info size={15} className="mt-0.5 shrink-0 text-accent" />}
          <span className={cx("whitespace-pre-wrap", m.kind === "error" ? "text-err" : "text-fg-2")}>{m.text}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
