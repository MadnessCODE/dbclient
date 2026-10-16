// Table Doctor: the slowest statements on the table, index suggestions from their plans, and a
// hypopg "what if" check before creating an index.
import { useEffect, useState } from "react";
import { ChevronRight, FlaskConical, Gauge, Info, RefreshCw, TriangleAlert } from "lucide-react";
import { api, errorText, type SlowQuery, type TableQueries, type WhatIf } from "../lib/api";
import { refKey, splitIgnored, type DoctorRef } from "../lib/doctor";
import { useStore } from "../store";
import { FindingRow, IgnoredList } from "./TableDoctor";
import { Button, cx, IconButton, Spinner } from "./ui";

const fmtMs = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(1)} ms`);

/** `version` changes when the table was analyzed again (e.g. after a fix). */
export function SlowQueries({ r, kind, database, version }: { r: DoctorRef; kind: "postgres" | "mysql"; database?: string; version?: number }) {
  const [data, setData] = useState<TableQueries | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showIgnored, setShowIgnored] = useState(false);
  const ignoredIds = useStore((s) => s.doctorIgnored[refKey(r)]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.tableQueries(r.connId, r.schema, r.table));
    } catch (e) {
      setError(errorText(e));
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.connId, r.schema, r.table, version]);

  const openQuery = (q: SlowQuery) => {
    const st = useStore.getState();
    const sql = q.sample ?? q.query;
    const id = st.newTab({ sql, connId: r.connId, title: `${r.table} query.sql`, database });
    void st.explainTab(id, sql);
  };

  const suggestions = data?.suggestions ?? [];
  const split = splitIgnored(
    suggestions.map((s) => s.finding),
    ignoredIds ?? [],
  );

  return (
    <section className="rounded-lg border border-line bg-panel">
      <header className="flex items-center gap-3 border-b border-line px-3.5 py-2.5">
        <Gauge size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold">Slow queries</h2>
        <span className="text-[11.5px] text-muted">{kind === "mysql" ? "from performance_schema" : "from pg_stat_statements"} · statements that use this table</span>
        <IconButton title="Read again" className="ml-auto" disabled={loading} onClick={() => void load()}>
          {loading ? <Spinner size={13} /> : <RefreshCw size={14} />}
        </IconButton>
      </header>

      <div className="space-y-4 px-3.5 py-3">
        {error && <p className="selectable text-[12.5px] text-err">{error}</p>}
        {!data && loading && (
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
            <Spinner /> Reading statement statistics and plans…
          </div>
        )}

        {data?.unavailable && (
          <div className="rounded-md border border-warn/40 bg-warn/10 px-3.5 py-3 text-[12.5px]">
            <div className="mb-1.5 flex items-center gap-2 font-medium text-fg">
              <Info size={14} className="text-warn" /> {data.unavailable.title}
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-fg-2">
              {data.unavailable.steps.map((s) => (
                <li key={s} className="selectable">
                  {s}
                </li>
              ))}
            </ol>
          </div>
        )}

        {data && !data.unavailable && (
          <>
            {data.queries.length === 0 ? (
              <p className="text-[12.5px] text-muted">No statements on this table have been recorded yet.</p>
            ) : (
              <table className="w-full table-fixed text-[12.5px]">
                <thead className="text-left text-[11.5px] text-muted">
                  <tr>
                    <th className="pb-1 font-normal">Statement</th>
                    <th className="w-20 pb-1 text-right font-normal">Calls</th>
                    <th className="w-24 pb-1 text-right font-normal">Total</th>
                    <th className="w-24 pb-1 text-right font-normal">Mean</th>
                    <th className="w-24 pb-1 text-right font-normal">Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {data.queries.map((q) => (
                    <tr key={q.id} onClick={() => openQuery(q)} title="Open in a new tab with its plan" className="cursor-pointer border-t border-line hover:bg-hover">
                      <td className="py-1.5 pr-3">
                        <code className="block truncate font-mono text-[12px] text-fg">{q.query}</code>
                      </td>
                      <td className="py-1.5 pl-2 text-right text-fg-2 tabular-nums">{q.calls.toLocaleString()}</td>
                      <td className="py-1.5 pl-2 text-right font-medium text-fg tabular-nums">{fmtMs(q.totalMs)}</td>
                      <td className="py-1.5 pl-2 text-right text-fg-2 tabular-nums">{fmtMs(q.meanMs)}</td>
                      <td className="py-1.5 pl-2 text-right text-fg-2 tabular-nums">{q.rows.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {split.active.length > 0 && (
              <div>
                <h3 className="mb-2 text-[12.5px] font-semibold">Suggested indexes</h3>
                <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                  {split.active.map((f) => {
                    const s = suggestions.find((x) => x.finding.id === f.id)!;
                    return (
                      <div key={f.id}>
                        <FindingRow r={r} f={f} database={database} open={!!open[f.id]} toggle={() => setOpen((o) => ({ ...o, [f.id]: !o[f.id] }))} />
                        {open[f.id] && kind === "postgres" && (
                          <WhatIfPanel r={r} columns={s.columns} queryIds={s.queryIds} hypopg={data.hypopg} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {split.ignored.length > 0 && (
              <div>
                <button onClick={() => setShowIgnored((v) => !v)} className="flex items-center gap-1.5 py-1 text-[12px] text-muted hover:text-fg">
                  <ChevronRight size={14} className={cx("transition-transform", showIgnored && "rotate-90")} />
                  Ignored suggestions ({split.ignored.length})
                </button>
                {showIgnored && <IgnoredList items={split.ignored.map((f) => ({ r, f }))} />}
              </div>
            )}
            {data.notes.map((n) => (
              <p key={n} className="flex items-start gap-2 text-[12px] text-muted">
                <Info size={13} className="mt-0.5 shrink-0" /> {n}
              </p>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/** hypopg: plan the statements with the index as if it existed; nothing is created. */
function WhatIfPanel({ r, columns, queryIds, hypopg }: { r: DoctorRef; columns: string[]; queryIds: string[]; hypopg: boolean }) {
  const [res, setRes] = useState<WhatIf | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!hypopg) {
    return (
      <p className="flex items-start gap-2 border-t border-line bg-panel-2 px-4 py-2.5 pl-[46px] text-[12px] text-muted">
        <FlaskConical size={13} className="mt-0.5 shrink-0" />
        Install the hypopg extension (CREATE EXTENSION hypopg) to see how much faster these queries would plan with this index, before creating it.
      </p>
    );
  }
  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      setRes(await api.whatIfIndex(r.connId, r.schema, r.table, columns, queryIds));
    } catch (e) {
      setError(errorText(e));
    }
    setLoading(false);
  };
  return (
    <div className="space-y-2 border-t border-line bg-panel-2 px-4 py-3 pl-[46px] text-[12.5px]">
      <div className="flex items-center gap-3">
        <Button onClick={() => void run()} disabled={loading}>
          {loading ? <Spinner size={12} /> : <FlaskConical size={14} />} What if?
        </Button>
        <span className="text-[12px] text-muted">Plans the queries with a hypothetical index (hypopg). Nothing is created and no query runs.</span>
      </div>
      {error && <p className="selectable text-err">{error}</p>}
      {res?.results.map((x) => {
        const gain = x.beforeCost && x.afterCost != null ? Math.round((1 - x.afterCost / x.beforeCost) * 100) : null;
        return (
          <div key={x.queryId} className="rounded-md border border-line bg-panel px-3 py-2">
            <code className="block truncate font-mono text-[12px] text-fg-2">{x.query}</code>
            {x.error ? (
              <p className="mt-1 text-[12px] text-err">{x.error}</p>
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="tabular-nums">
                  Cost {Math.round(x.beforeCost ?? 0).toLocaleString()} → <b className={x.usesIndex ? "text-ok" : "text-fg"}>{Math.round(x.afterCost ?? 0).toLocaleString()}</b>
                  {gain != null && gain > 0 && <span className="ml-1.5 text-ok">−{gain}%</span>}
                </span>
                <span className="text-fg-2">
                  {x.beforeScan ?? "?"} → {x.afterScan ?? "?"}
                </span>
                {!x.usesIndex && (
                  <span className="flex items-center gap-1 text-warn">
                    <TriangleAlert size={12} /> The planner would not use this index here
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
