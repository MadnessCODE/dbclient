// Server processes: who is connected, what they run and for how long; queries or connections can be stopped.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Ban, ChevronDown, Copy, Hourglass, Lock, Pause, Play, Plug, RefreshCw, Search, SquareTerminal, TriangleAlert, X, Zap } from "lucide-react";
import { errorText } from "../lib/api";
import { connColor, isProduction, tint } from "../lib/connStyle";
import { fmtDuration, isActive, isIdle, listProcesses, stopProcess, type Proc } from "../lib/processes";
import { useStore } from "../store";
import { Button, cx, DbIcon, EnvBadge, Modal, Spinner, StatusDot } from "./ui";
import { Menu } from "./EditorArea";
import { baseId } from "../lib/connIds";

const INTERVALS: [number, string][] = [
  [2000, "2 s"],
  [5000, "5 s"],
  [10000, "10 s"],
  [0, "Off"],
];

/** Duration color: normal up to 10 s, warning up to a minute, then red. */
const durTone = (p: Proc, s: number) => (!isActive(p) && !p.state.includes("transaction") ? "text-fg-2" : s >= 60 ? "text-err" : s >= 10 ? "text-warn" : "text-fg");

export function ProcessesView() {
  const connections = useStore((s) => s.connections);
  const connState = useStore((s) => s.conn);
  const selected = useStore((s) => s.selectedConnId);
  const connected = connections.filter((c) => connState[c.id]?.status === "connected");

  const [connId, setConnId] = useState<string | null>(() => connected.find((c) => c.id === selected)?.id ?? connected[0]?.id ?? null);
  const cfg = connections.find((c) => c.id === baseId(connId)) ?? null;
  useEffect(() => {
    if (!connId || !connected.some((c) => c.id === connId)) setConnId(connected[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected.length]);

  const [interval, setIntervalMs] = useState(2000);
  const [paused, setPaused] = useState(false);
  const [hideIdle, setHideIdle] = useState(true);
  const [showSystem, setShowSystem] = useState(false);
  const [filter, setFilter] = useState("");
  const [procs, setProcs] = useState<Proc[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ proc: Proc; what: "query" | "connection" } | null>(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    if (!connId || !cfg) return;
    setLoading(true);
    try {
      const list = await listProcesses(connId, cfg.kind, showSystem);
      setProcs(list);
      setFetchedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [connId, cfg, showSystem]);

  useEffect(() => {
    setProcs(null);
    setDetail(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (!interval || paused) return;
    const t = setInterval(() => void load(), interval);
    return () => clearInterval(t);
  }, [interval, paused, load]);
  // tick active durations between refreshes
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  const elapsed = (p: Proc) => p.seconds + (isActive(p) && !p.self && !paused ? (Date.now() - fetchedAt) / 1000 : 0);
  const blockers = useMemo(() => new Set((procs ?? []).flatMap((p) => p.blockedBy)), [procs]);
  const visible = useMemo(() => {
    const q = filter.toLowerCase();
    // hide our own listing query (it may run on a different pooled connection each time)
    return (procs ?? []).filter(
      (p) => (showSystem || !p.self) && (!hideIdle || !isIdle(p) || blockers.has(p.pid)) && (!q || [p.pid, p.user, p.database, p.client, p.app, p.state, p.query].join(" ").toLowerCase().includes(q)),
    );
  }, [procs, filter, hideIdle, blockers, showSystem]);

  const all = (procs ?? []).filter((p) => !p.self);
  const active = all.filter(isActive);
  const blocked = all.filter((p) => p.blockedBy.length > 0 || /lock/i.test(p.wait));
  const longest = active.filter((p) => !p.self).reduce<Proc | null>((a, p) => (!a || p.seconds > a.seconds ? p : a), null);
  const det = detail != null ? all.find((p) => p.pid === detail) : undefined;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-5 py-3">
        <div className="mr-2 flex items-center gap-2">
          <Activity size={18} className="text-accent" />
          <h1 className="text-[16px] font-semibold text-fg">Processes</h1>
        </div>
        <ConnPicker connId={connId} onPick={setConnId} />
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-lg border border-line-strong bg-panel-2 p-0.5" title="Auto refresh">
            {INTERVALS.map(([ms, label]) => (
              <button key={ms} onClick={() => setIntervalMs(ms)} className={cx("h-7 rounded-md px-2.5 text-[12px]", interval === ms ? "bg-accent text-white" : "text-fg-2 hover:text-fg")}>
                {label}
              </button>
            ))}
          </div>
          {interval > 0 && (
            <Button className="h-8 w-8 !px-0" title={paused ? "Resume auto refresh" : "Pause auto refresh"} onClick={() => setPaused(!paused)}>
              {paused ? <Play size={14} /> : <Pause size={14} />}
            </Button>
          )}
          <Button className="h-8 w-8 !px-0" title="Refresh now" disabled={!connId} onClick={() => void load()}>
            <RefreshCw size={14} className={cx(loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {!connId ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted">
          <Activity size={36} className="text-accent/60" />
          <span className="text-[14px] text-fg-2">No connected databases</span>
          <span className="text-[12.5px]">Connect from the Connections panel, then come back here.</span>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-5">
            {/* stats */}
            <div className="grid grid-cols-4 gap-3">
              <StatCard icon={<Plug size={16} />} label="Sessions" value={all.length} />
              <StatCard icon={<Zap size={16} />} label="Running now" value={active.filter((p) => !p.self).length} tone={active.length > 1 ? "accent" : undefined} />
              <StatCard icon={<Lock size={16} />} label="Waiting on locks" value={blocked.length} tone={blocked.length ? "err" : undefined} />
              <StatCard
                icon={<Hourglass size={16} />}
                label="Longest running"
                value={longest ? fmtDuration(elapsed(longest)) : "—"}
                sub={longest ? `PID ${longest.pid} · ${longest.user}` : undefined}
                tone={longest && elapsed(longest) >= 60 ? "err" : longest && elapsed(longest) >= 10 ? "warn" : undefined}
                onClick={longest ? () => setDetail(longest.pid) : undefined}
              />
            </div>

            {/* filters */}
            <div className="flex items-center gap-2">
              <div className="relative w-72">
                <Search size={14} className="absolute left-2.5 top-2 text-muted" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter by user, database, query…"
                  className="h-8 w-full rounded-md border border-line-strong bg-bg/50 pl-8 pr-2.5 text-[13px] text-fg outline-none focus:border-accent"
                />
              </div>
              <Chip on={hideIdle} onClick={() => setHideIdle(!hideIdle)} label="Hide idle" />
              <Chip on={showSystem} onClick={() => setShowSystem(!showSystem)} label="Show system" />
              <span className="ml-auto text-[12px] text-muted">
                {visible.length} of {all.length} shown{paused ? " · paused" : interval ? "" : " · auto refresh off"}
              </span>
            </div>
            {error && (
              <p className="flex items-start gap-2 rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-[12.5px] text-err">
                <TriangleAlert size={15} className="mt-px shrink-0" /> {error}
              </p>
            )}

            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-panel-2">
              {!procs ? (
                <div className="flex h-40 items-center justify-center">
                  <Spinner />
                </div>
              ) : (
                <table className="w-full border-collapse text-[12.5px]">
                  <thead className="sticky top-0 z-10 bg-panel text-left text-[11px] uppercase tracking-wider text-muted">
                    <tr>
                      <th className="w-6 px-3 py-2" />
                      <th className="px-2 py-2 font-semibold">PID</th>
                      <th className="px-2 py-2 font-semibold">User</th>
                      <th className="px-2 py-2 font-semibold">Database</th>
                      <th className="px-2 py-2 font-semibold">Client</th>
                      <th className="px-2 py-2 font-semibold">State</th>
                      <th className="px-2 py-2 text-right font-semibold">Duration</th>
                      <th className="w-[40%] px-2 py-2 font-semibold">Query</th>
                      <th className="w-20 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((p) => {
                      const s = elapsed(p);
                      const waiting = p.blockedBy.length > 0 || /lock/i.test(p.wait);
                      return (
                        <tr
                          key={p.pid}
                          onClick={() => !p.self && setDetail(p.pid)}
                          className={cx("group border-t border-line", p.self ? "cursor-default opacity-60" : "cursor-pointer", detail === p.pid ? "bg-accent-soft" : !p.self && "hover:bg-hover/60")}
                        >
                          <td className="px-3 py-1.5">
                            <span
                              className={cx(
                                "block h-2 w-2 rounded-full",
                                waiting ? "bg-err" : isActive(p) ? "animate-pulse bg-ok" : p.state.includes("transaction") ? "bg-warn" : "bg-line-strong",
                              )}
                            />
                          </td>
                          <td className="px-2 py-1.5 font-mono tabular-nums text-fg-2">{p.pid}</td>
                          <td className="px-2 py-1.5 text-fg">{p.user || <span className="text-muted">—</span>}</td>
                          <td className="px-2 py-1.5 text-fg-2">{p.database}</td>
                          <td className="max-w-[160px] truncate px-2 py-1.5 text-fg-2" title={[p.client, p.app].filter(Boolean).join(" · ")}>
                            {p.ours ? <span className="rounded bg-accent/15 px-1.5 py-px text-[11px] text-accent">{p.self ? "this view" : "DB Client"}</span> : p.app || p.client}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5">
                            <span className={cx("text-[12px]", waiting ? "text-err" : isActive(p) ? "text-ok" : "text-fg-2")}>{waiting ? `waiting${p.blockedBy.length ? ` on ${p.blockedBy.join(", ")}` : ""}` : p.state}</span>
                            {p.wait && !waiting && !blockers.has(p.pid) && (
                              <span className="ml-1 inline-block max-w-[150px] truncate align-bottom text-[11px] text-muted" title={p.wait}>
                                ({p.wait})
                              </span>
                            )}
                            {blockers.has(p.pid) && (
                              <span className="ml-1.5 rounded bg-err/15 px-1.5 py-px text-[10.5px] font-semibold text-err" title="Other sessions are waiting for this one">
                                blocking {all.filter((x) => x.blockedBy.includes(p.pid)).length}
                              </span>
                            )}
                          </td>
                          <td className={cx("px-2 py-1.5 text-right font-mono tabular-nums", durTone(p, s))}>{fmtDuration(s)}</td>
                          <td className="max-w-0 px-2 py-1.5">
                            <span className="block truncate font-mono text-[11.5px] text-fg-2">{p.query.replace(/\s+/g, " ") || <span className="text-muted">—</span>}</span>
                          </td>
                          <td className="px-2 py-1.5">
                            {!p.self && (
                              <span className="flex justify-end gap-1 opacity-0 group-hover:opacity-100">
                                {isActive(p) && (
                                  <button
                                    title="Cancel the running query"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConfirm({ proc: p, what: "query" });
                                    }}
                                    className="rounded p-1 text-warn hover:bg-warn/15"
                                  >
                                    <Ban size={14} />
                                  </button>
                                )}
                                <button
                                  title="Kill the connection"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConfirm({ proc: p, what: "connection" });
                                  }}
                                  className="rounded p-1 text-err hover:bg-err/15"
                                >
                                  <X size={14} />
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {procs && visible.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-muted">{!all.length ? "No sessions." : hideIdle && !filter ? "No queries are running right now. Turn off “Hide idle” to see every session." : "Nothing matches the filters."}</p>}
            </div>
          </div>

          {/* details */}
          {det && (
            <aside className="flex w-[400px] shrink-0 flex-col border-l border-line bg-panel">
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <span className="text-[14px] font-semibold text-fg">Process {det.pid}</span>
                <button onClick={() => setDetail(null)} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
                  <X size={15} />
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-[12.5px]">
                <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
                  <Row k="User" v={det.user} />
                  <Row k="Database" v={det.database} />
                  <Row k="Client" v={det.client} />
                  {det.app && <Row k="Application" v={det.app} />}
                  <Row k="State" v={det.state} />
                  {det.wait && <Row k="Waiting on" v={det.wait} />}
                  <Row k="Duration" v={fmtDuration(elapsed(det))} />
                  {det.txSeconds != null && <Row k="Transaction" v={`open for ${fmtDuration(det.txSeconds)}`} />}
                  {det.blockedBy.length > 0 && <Row k="Blocked by" v={det.blockedBy.join(", ")} tone="text-err" />}
                  {blockers.has(det.pid) && <Row k="Blocking" v={all.filter((p) => p.blockedBy.includes(det.pid)).map((p) => p.pid).join(", ")} tone="text-err" />}
                </dl>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{isActive(det) ? "Running query" : "Last query"}</span>
                    <span className="flex gap-1">
                      <button title="Copy" disabled={!det.query} onClick={() => void navigator.clipboard.writeText(det.query)} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
                        <Copy size={13} />
                      </button>
                      <button
                        title="Open in a new query tab"
                        disabled={!det.query}
                        onClick={() => useStore.getState().newTab({ sql: det.query, connId, title: `pid_${det.pid}.sql` })}
                        className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
                      >
                        <SquareTerminal size={13} />
                      </button>
                    </span>
                  </div>
                  <pre className="selectable max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-bg/60 p-3 font-mono text-[12px] leading-relaxed text-fg-2">
                    {det.query || "—"}
                  </pre>
                </div>
              </div>
              {!det.self && (
                <div className="flex gap-2 border-t border-line p-4">
                  <Button className="flex-1" disabled={!isActive(det)} onClick={() => setConfirm({ proc: det, what: "query" })} title="Stops the query; the connection stays open">
                    <Ban size={14} /> Cancel query
                  </Button>
                  <Button variant="danger" className="flex-1" onClick={() => setConfirm({ proc: det, what: "connection" })} title="Closes the whole session">
                    <X size={14} /> Kill connection
                  </Button>
                </div>
              )}
              {det.self && <p className="border-t border-line p-4 text-[12px] text-muted">This is the connection this view uses to read the list.</p>}
            </aside>
          )}
        </div>
      )}

      {confirm && cfg && connId && (
        <StopDialog
          proc={confirm.proc}
          what={confirm.what}
          production={isProduction(cfg)}
          onClose={() => setConfirm(null)}
          onStop={async () => {
            await stopProcess(connId, cfg.kind, confirm.proc.pid, confirm.what);
            setConfirm(null);
            setTimeout(() => void load(), 300);
          }}
        />
      )}
    </main>
  );
}

/** Connection picker: connected first, the rest connect on click. */
function ConnPicker({ connId, onPick }: { connId: string | null; onPick: (id: string) => void }) {
  const connections = useStore((s) => s.connections);
  const conn = useStore((s) => s.conn);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const cfg = connections.find((c) => c.id === baseId(connId));
  const color = connColor(cfg);
  const match = (c: (typeof connections)[number]) => `${c.name} ${c.host} ${c.database}`.toLowerCase().includes(q.toLowerCase());
  const on = connections.filter((c) => conn[c.id]?.status === "connected" && match(c));
  const off = connections.filter((c) => conn[c.id]?.status !== "connected" && match(c));

  const item = (c: (typeof connections)[number]) => (
    <button
      key={c.id}
      onClick={() => {
        if (conn[c.id]?.status !== "connected") void useStore.getState().connectTo(c.id).then((ok) => ok && onPick(c.id));
        else onPick(c.id);
        setOpen(false);
        setQ("");
      }}
      className={cx("flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-hover", c.id === connId && "bg-accent-soft")}
    >
      <DbIcon kind={c.kind} size={15} />
      <StatusDot status={conn[c.id]?.status} className="h-2 w-2" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-fg">{c.name}</span>
        <span className="block truncate text-[11px] text-muted">
          {c.host}:{c.port}
          {c.database ? ` / ${c.database}` : ""}
        </span>
      </span>
      <EnvBadge cfg={c} />
    </button>
  );

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        style={color ? { borderColor: color, background: tint(color, 0.1) } : undefined}
        className="flex h-9 w-[320px] items-center gap-2 rounded-md border border-line-strong bg-panel-2 px-2.5 text-left text-[13px] hover:border-accent/60"
      >
        {cfg ? (
          <>
            <DbIcon kind={cfg.kind} size={16} />
            <StatusDot status={conn[cfg.id]?.status} className="h-2 w-2" />
            <span className="flex-1 truncate text-fg">{cfg.name}</span>
            <EnvBadge cfg={cfg} />
          </>
        ) : (
          <span className="flex-1 text-muted">Choose a connection…</span>
        )}
        <ChevronDown size={15} className="text-muted" />
      </button>
      {open && (
        <Menu onClose={() => setOpen(false)} width={320}>
          {connections.length > 6 && (
            <div className="relative mb-1">
              <Search size={13} className="absolute left-2.5 top-2 text-muted" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a connection…"
                className="h-7 w-full rounded-md border border-line-strong bg-bg/50 pl-7 pr-2 text-[12.5px] text-fg outline-none focus:border-accent"
              />
            </div>
          )}
          <div className="max-h-[60vh] overflow-y-auto">
            {on.length > 0 && <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">Connected</div>}
            {on.map(item)}
            {off.length > 0 && <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted">Not connected · click to connect</div>}
            {off.map(item)}
            {on.length + off.length === 0 && <div className="px-2.5 py-2 text-[12px] text-muted">No connections match.</div>}
          </div>
        </Menu>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, sub, tone, onClick }: { icon: React.ReactNode; label: string; value: string | number; sub?: string; tone?: "accent" | "warn" | "err"; onClick?: () => void }) {
  const color = tone === "err" ? "text-err" : tone === "warn" ? "text-warn" : tone === "accent" ? "text-accent" : "text-fg";
  return (
    <button disabled={!onClick} onClick={onClick} className="flex items-center gap-3 rounded-xl border border-line bg-panel-2 px-4 py-3 text-left enabled:hover:border-accent/50">
      <span className={cx("flex h-9 w-9 items-center justify-center rounded-lg bg-hover", color)}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[11px] uppercase tracking-wider text-muted">{label}</span>
        <span className={cx("block font-mono text-[18px] font-semibold tabular-nums", color)}>{value}</span>
        {sub && <span className="block truncate text-[11px] text-muted">{sub}</span>}
      </span>
    </button>
  );
}

function Chip({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} className={cx("h-8 rounded-md border px-3 text-[12.5px]", on ? "border-accent bg-accent-soft text-fg" : "border-line-strong bg-panel-2 text-fg-2 hover:bg-hover hover:text-fg")}>
      {label}
    </button>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className={cx("selectable min-w-0 break-words", tone ?? "text-fg")}>{v || "—"}</dd>
    </>
  );
}

function StopDialog({ proc, what, production, onClose, onStop }: { proc: Proc; what: "query" | "connection"; production: boolean; onClose: () => void; onStop: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(!production);
  const title = what === "query" ? "Cancel query" : "Kill connection";
  return (
    <Modal title={title} onClose={onClose} width={560}>
      <div className="space-y-3 px-5 py-4">
        <p className="text-[13px] leading-relaxed text-fg-2">
          {what === "query" ? (
            <>
              The running query of process <b className="text-fg">{proc.pid}</b> ({proc.user}) will be stopped. Its connection stays open; if it was inside a transaction, that statement fails.
            </>
          ) : (
            <>
              Process <b className="text-fg">{proc.pid}</b> ({proc.user}) will be disconnected. Anything it hasn&apos;t committed is rolled back, and the application using it will see a lost connection.
            </>
          )}
        </p>
        {proc.ours && <p className="text-[12.5px] text-warn">This connection belongs to DB Client itself (for example, a query tab). It will reconnect on the next query.</p>}
        {proc.query && <pre className="selectable max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-bg/50 p-3 font-mono text-[12px] text-fg-2">{proc.query}</pre>}
        {production && (
          <button onClick={() => setOk(!ok)} className="flex w-full items-center gap-2.5 rounded-lg border border-err/40 bg-err/10 p-3 text-left text-[13px] text-err">
            <span className={cx("flex h-4 w-4 items-center justify-center rounded border", ok ? "border-err bg-err text-white" : "border-err/60")}>{ok && <span className="text-[10px]">✓</span>}</span>
            This is a PRODUCTION database — I know what this process is
          </button>
        )}
        {error && <p className="selectable rounded-md bg-err/10 px-3 py-2 text-[13px] text-err">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={onClose}>
            Keep it running
          </Button>
          <Button
            variant={what === "connection" || production ? "danger" : "primary"}
            disabled={busy || !ok}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onStop();
              } catch (e) {
                setError(errorText(e));
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : what === "query" ? <Ban size={14} /> : <X size={14} />} {title}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
