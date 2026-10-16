// Explain tab: the plan as a tree (cost or time share per step, estimated vs actual rows, warnings),
// with the raw text one click away. Explain Analyze runs on PostgreSQL inside a rolled-back transaction.
import { useMemo, useState } from "react";
import { ChevronRight, Flame, ListTree, Play, TriangleAlert } from "lucide-react";
import { parsePlan, type PlanNode } from "../lib/plan";
import { useStore, type EditorTab, type TabRuntime } from "../store";
import { Button, cx, MOD, Spinner } from "./ui";

const fmtRows = (n: number | null) => (n == null ? "—" : n >= 10_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toLocaleString());
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 10 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(2)} ms`);

export function ExplainView({ tab, rt, kind }: { tab: EditorTab; rt: TabRuntime | undefined; kind: "postgres" | "mysql" }) {
  const [raw, setRaw] = useState(false);
  const ex = rt?.explain;
  const plan = useMemo(() => (ex?.json ? parsePlan(ex.json, kind) : null), [ex?.json, kind]);
  const explain = (analyze: boolean) => ex && void useStore.getState().explainTab(tab.id, ex.sql, analyze);

  if (rt?.explaining) {
    return (
      <div className="flex items-center gap-2 p-4 text-muted">
        <Spinner /> Explaining…
      </div>
    );
  }
  if (!ex) {
    return <p className="p-4 text-muted">Click “Explain” ({MOD}+E) to see how the database will execute the current statement.</p>;
  }
  const warnings = plan ? countWarnings(plan.root) : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="flex rounded-md border border-line-strong p-0.5 text-[12px]">
          {(["Tree", "Raw"] as const).map((m) => (
            <button
              key={m}
              disabled={m === "Tree" && !plan}
              onClick={() => setRaw(m === "Raw")}
              className={cx("rounded px-2.5 py-0.5 disabled:opacity-40", (m === "Raw") === (raw || !plan) ? "bg-accent-soft text-fg" : "text-fg-2 hover:text-fg")}
            >
              {m}
            </button>
          ))}
        </div>
        {plan && (
          <span className="text-[12px] text-fg-2">
            {ex.analyzed ? (
              <>
                <b className="text-fg">Analyzed</b> · executed in {plan.executionMs != null ? fmtMs(plan.executionMs) : "?"}
                {plan.planningMs != null && ` · planned in ${fmtMs(plan.planningMs)}`} · in a rolled-back transaction
              </>
            ) : (
              <>Estimated cost {Math.round(plan.totalCost).toLocaleString()}</>
            )}
            {warnings > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-warn">
                <TriangleAlert size={12} /> {warnings} warning{warnings > 1 ? "s" : ""}
              </span>
            )}
          </span>
        )}
        <div className="ml-auto flex gap-1.5">
          <Button className="h-7" onClick={() => explain(false)} title="Plan only; nothing runs">
            <ListTree size={14} /> Explain
          </Button>
          {kind === "postgres" && (
            <Button className="h-7" onClick={() => explain(true)} title="Runs the statement to measure it; data changes are rolled back">
              <Play size={13} /> Explain Analyze
            </Button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {raw || !plan ? (
          <pre className="selectable p-4 font-mono text-[12.5px] leading-relaxed text-fg-2">{ex.text}</pre>
        ) : (
          <div className="py-1">
            <NodeRow n={plan.root} depth={0} analyzed={plan.analyzed} />
          </div>
        )}
      </div>
    </div>
  );
}

function countWarnings(n: PlanNode): number {
  return n.warnings.length + n.children.reduce((a, c) => a + countWarnings(c), 0);
}

function NodeRow({ n, depth, analyzed }: { n: PlanNode; depth: number; analyzed: boolean }) {
  const [open, setOpen] = useState(true);
  const [details, setDetails] = useState(false);
  const pct = Math.round(n.share * 100);
  const color = n.share >= 0.3 ? "var(--err)" : n.share >= 0.1 ? "var(--warn)" : "var(--accent)";
  return (
    <>
      <div
        onClick={() => setDetails((v) => !v)}
        style={{ paddingLeft: 10 + depth * 18 }}
        className={cx(
          "group flex cursor-pointer items-center gap-2 border-l-2 py-1 pr-3 text-[12.5px] hover:bg-hover",
          n.hot ? "border-l-err bg-err/5" : "border-l-transparent",
        )}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className={cx("rounded p-0.5 text-muted hover:text-fg", !n.children.length && "invisible")}
        >
          <ChevronRight size={13} className={cx("transition-transform", open && "rotate-90")} />
        </button>
        {n.hot && <Flame size={13} className="shrink-0 text-err" />}
        <span className="shrink-0 font-semibold text-fg">{n.op}</span>
        <span className="min-w-0 truncate text-fg-2">{n.detail}</span>
        {n.warnings.length > 0 && <TriangleAlert size={13} className="shrink-0 text-warn" />}
        <span className="ml-auto flex shrink-0 items-center gap-3 tabular-nums">
          <span className="w-[150px] text-right text-[11.5px] text-fg-2" title={analyzed ? "Estimated → actual rows" : "Estimated rows"}>
            {analyzed ? (
              <>
                {fmtRows(n.estRows)} → <span className={rowsOff(n) ? "font-semibold text-warn" : "text-fg"}>{fmtRows(n.actualRows)}</span> rows
              </>
            ) : (
              n.estRows != null && <>{fmtRows(n.estRows)} rows</>
            )}
          </span>
          <span className="w-[86px] text-right text-[11.5px] text-fg-2">{analyzed && n.time != null ? fmtMs(n.time) : `cost ${Math.round(n.cost).toLocaleString()}`}</span>
          <span className="flex w-[120px] items-center gap-1.5" title={`${pct}% of the ${analyzed ? "time" : "cost"} is spent in this step itself`}>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover">
              <span className="block h-full rounded-full" style={{ width: `${Math.max(n.share > 0 ? 2 : 0, pct)}%`, background: color }} />
            </span>
            <span className="w-8 text-right text-[11px] text-fg-2">{pct}%</span>
          </span>
        </span>
      </div>
      {n.warnings.map((w) => (
        <div key={w} style={{ paddingLeft: 40 + depth * 18 }} className="flex items-start gap-1.5 pr-3 pb-1 text-[12px] text-warn">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" /> {w}
        </div>
      ))}
      {details && n.info.length > 0 && (
        <dl style={{ paddingLeft: 40 + depth * 18 }} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pr-3 pb-1.5 text-[12px]">
          {n.info.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="selectable font-mono break-all text-fg-2">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {open && n.children.map((c) => <NodeRow key={c.id} n={c} depth={depth + 1} analyzed={analyzed} />)}
    </>
  );
}

function rowsOff(n: PlanNode) {
  if (n.estRows == null || n.actualRows == null) return false;
  const hi = Math.max(n.estRows, n.actualRows);
  return hi >= 100 && hi / Math.max(1, Math.min(n.estRows, n.actualRows)) >= 10;
}
