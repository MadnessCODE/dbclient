// Database Doctor tab: the most important findings across every table of some schemas,
// ranked by table size × severity, with the same fixes as Table Doctor.
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Info, RefreshCw, Stethoscope } from "lucide-react";
import type { Finding, Severity } from "../lib/api";
import { dbTables, openDoctor, refKey, scanTab, scoreOf, splitIgnored, useDoctor, WEIGHT, type DoctorRef } from "../lib/doctor";
import { isDone, jobPercent, useImports } from "../lib/importJobs";
import { baseId, dbOf } from "../lib/connIds";
import { useStore, type EditorTab } from "../store";
import { formatBytes } from "./LeftPanel";
import { FindingRow, IgnoredList, ScoreRing, scoreColor, SEV, Summary } from "./TableDoctor";
import { Button, cx, DbIcon, EnvBadge, SearchInput, Spinner } from "./ui";

/** Findings listed at once; the rest are behind "Show more". */
const PAGE = 100;

export function DatabaseDoctor({ tab }: { tab: EditorTab }) {
  const spec = tab.dbDoctor!;
  const connId = tab.connId ?? "";
  const cfg = useStore((s) => s.connections.find((c) => c.id === baseId(connId)));
  const res = useDoctor((s) => s.dbTabs[tab.id]);
  const schemas = useDoctor((s) => s.schemas);
  const ignoredMap = useStore((s) => s.doctorIgnored);
  const job = useImports((s) => s.jobs.find((j) => j.id === res?.jobId));
  const running = !!job && !isDone(job);
  const [sev, setSev] = useState<Severity | "all">("all");
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showIgnored, setShowIgnored] = useState(false);
  const mysql = cfg?.kind === "mysql";

  useEffect(() => {
    if (!useDoctor.getState().dbTabs[tab.id]) void scanTab(tab.id);
  }, [tab.id]);

  const tables = useMemo(() => dbTables(schemas, connId, spec.schemas), [schemas, connId, spec.schemas]);

  // every finding with its table, ignored ones apart; impact = severity weight × table size
  const { ranked, ignored, perTable } = useMemo(() => {
    const ranked: { r: DoctorRef; f: Finding; impact: number }[] = [];
    const ignored: { r: DoctorRef; f: Finding }[] = [];
    const perTable = tables.map((t) => {
      const r: DoctorRef = { connId, schema: t.schema, table: t.table };
      const split = splitIgnored(t.findings, ignoredMap[refKey(r)] ?? []);
      for (const f of split.active) ranked.push({ r, f, impact: WEIGHT[f.severity] * Math.max(t.bytes, 8192) });
      for (const f of split.ignored) ignored.push({ r, f });
      return { ...t, r, active: split.active };
    });
    ranked.sort((a, b) => b.impact - a.impact);
    return { ranked, ignored, perTable };
  }, [tables, ignoredMap, connId]);

  const q = filter.trim().toLowerCase();
  const visible = ranked.filter((x) => (sev === "all" || x.f.severity === sev) && (!q || `${x.r.schema}.${x.r.table}`.toLowerCase().includes(q)));
  const sick = perTable.filter((t) => t.active.length > 0).sort((a, b) => scoreOf(a.active) - scoreOf(b.active) || b.bytes - a.bytes);
  const allActive = ranked.map((x) => x.f);
  const score = tables.length ? Math.round(perTable.reduce((a, t) => a + scoreOf(t.active), 0) / perTable.length) : undefined;
  const notes = [...new Set(spec.schemas.flatMap((s) => schemas[`${connId}|${s}`]?.notes ?? []))];
  const where = [cfg?.name, dbOf(connId)].filter(Boolean).join(" / ");
  const database = (schema: string) => (mysql ? schema : undefined);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-4 border-b border-line px-5 py-4">
        <ScoreRing score={score} loading={running && !tables.length} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Stethoscope size={16} className="shrink-0 text-accent" />
            <h1 className="truncate text-[16px] font-semibold">{spec.label}</h1>
            <span className="text-[12px] text-muted">
              {spec.schemas.length} {mysql ? "database" : "schema"}
              {spec.schemas.length === 1 ? "" : "s"} · {tables.length} tables
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-muted">
            {cfg && <DbIcon kind={cfg.kind} size={14} />}
            <span className="truncate">{where}</span>
            <EnvBadge cfg={cfg} />
            {res?.at && !running && <span>· analyzed {new Date(res.at).toLocaleTimeString()}</span>}
          </div>
          {tables.length > 0 && <Summary findings={allActive} ignored={ignored.length} />}
        </div>
        <Button onClick={() => void scanTab(tab.id)} disabled={running} className="h-9 px-4">
          {running ? <Spinner /> : <RefreshCw size={15} />} Re-run
        </Button>
      </header>

      {running && job && (
        <div className="flex items-center gap-3 border-b border-line px-5 py-2 text-[12px] text-fg-2">
          <span>
            Analyzing {mysql ? "database" : "schema"} {Math.min((job.done ?? 0) + 1, spec.schemas.length)} of {spec.schemas.length} in the background
          </span>
          <span className="h-1 w-40 overflow-hidden rounded-full bg-hover">
            <span className="block h-full rounded-full bg-accent transition-[width]" style={{ width: `${jobPercent(job)}%` }} />
          </span>
          <button className="text-accent hover:underline" onClick={() => useImports.getState().show(job.id)}>
            View
          </button>
        </div>
      )}
      {res?.error && <p className="selectable mx-5 mt-4 rounded-md bg-err/10 px-3 py-2 text-[13px] text-err">{res.error}</p>}

      <div className="space-y-5 px-5 py-4">
        {tables.length === 0 && running ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted">
            <Spinner /> Reading statistics of every table…
          </div>
        ) : (
          <>
            <section>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 className="mr-2 text-[13px] font-semibold">Top issues</h2>
                {(["all", "critical", "warning", "info"] as const).map((s) => {
                  const n = s === "all" ? ranked.length : ranked.filter((x) => x.f.severity === s).length;
                  return (
                    <button
                      key={s}
                      onClick={() => setSev(s)}
                      className={cx(
                        "rounded-full border px-2.5 py-0.5 text-[11.5px]",
                        sev === s ? "border-accent bg-accent-soft text-fg" : "border-line text-fg-2 hover:bg-hover",
                      )}
                    >
                      {s === "all" ? "All" : SEV[s].label} {n}
                    </button>
                  );
                })}
                <SearchInput className="ml-auto w-[240px]" value={filter} onChange={setFilter} placeholder="Filter tables…" />
              </div>
              {visible.length === 0 ? (
                <p className="rounded-lg border border-line bg-panel px-4 py-3 text-[13px] text-muted">
                  {ranked.length === 0 ? "No problems found in these tables." : "Nothing matches the filter."}
                </p>
              ) : (
                <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
                  {visible.slice(0, shown).map(({ r, f }) => {
                    const k = `${refKey(r)}#${f.id}`;
                    return <FindingRow key={k} r={r} f={f} showTable database={database(r.schema)} open={!!open[k]} toggle={() => setOpen((o) => ({ ...o, [k]: !o[k] }))} />;
                  })}
                </div>
              )}
              {visible.length > shown && (
                <Button variant="ghost" className="mt-2" onClick={() => setShown((n) => n + PAGE)}>
                  Show more ({visible.length - shown} left)
                </Button>
              )}
              {ignored.length > 0 && (
                <div className="mt-2">
                  <button onClick={() => setShowIgnored((v) => !v)} className="flex items-center gap-1.5 py-1 text-[12px] text-muted hover:text-fg">
                    <ChevronRight size={14} className={cx("transition-transform", showIgnored && "rotate-90")} />
                    Ignored ({ignored.length})
                  </button>
                  {showIgnored && <IgnoredList items={ignored} showTable />}
                </div>
              )}
            </section>

            {sick.length > 0 && (
              <section className="rounded-lg border border-line bg-panel">
                <header className="border-b border-line px-3.5 py-2.5">
                  <h2 className="text-[13px] font-semibold">Tables with issues ({sick.length})</h2>
                </header>
                <div className="max-h-[420px] overflow-y-auto">
                  <table className="w-full text-[12.5px]">
                    <thead className="sticky top-0 bg-panel text-left text-[11.5px] text-muted">
                      <tr>
                        <th className="px-3.5 py-1.5 font-normal">Table</th>
                        <th className="px-2 py-1.5 text-right font-normal">Score</th>
                        <th className="px-2 py-1.5 font-normal">Issues</th>
                        <th className="px-2 py-1.5 text-right font-normal">Rows</th>
                        <th className="px-3.5 py-1.5 text-right font-normal">Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sick.map((t) => {
                        const sc = scoreOf(t.active);
                        return (
                          <tr
                            key={refKey(t.r)}
                            onClick={() => openDoctor(connId, t.schema, t.table, database(t.schema))}
                            title="Open Table Doctor"
                            className="cursor-pointer border-t border-line hover:bg-hover"
                          >
                            <td className="px-3.5 py-1.5 font-mono text-fg">
                              <span className="text-muted">{t.schema}.</span>
                              {t.table}
                            </td>
                            <td className="px-2 py-1.5 text-right font-semibold tabular-nums" style={{ color: scoreColor(sc) }}>
                              {sc}
                            </td>
                            <td className="px-2 py-1.5">
                              <span className="flex gap-1.5">
                                {(["critical", "warning", "info"] as const).map((s) => {
                                  const n = t.active.filter((f) => f.severity === s).length;
                                  return n ? (
                                    <span key={s} className={cx("rounded px-1.5 text-[11px] font-medium", SEV[s].bg, SEV[s].text)}>
                                      {n}
                                    </span>
                                  ) : null;
                                })}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 text-right text-fg-2 tabular-nums">{t.rows == null ? "—" : t.rows.toLocaleString()}</td>
                            <td className="px-3.5 py-1.5 text-right text-fg-2 tabular-nums">{formatBytes(t.bytes)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {notes.length > 0 && (
              <div className="space-y-1">
                {notes.map((n) => (
                  <p key={n} className="flex items-start gap-2 text-[12px] text-muted">
                    <Info size={13} className="mt-0.5 shrink-0" /> {n}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
