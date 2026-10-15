// Table Doctor tab: health score, key metrics, findings with fixes, index usage and space use of one table.
import { useEffect, useState } from "react";
import {
  ChevronRight,
  CircleCheck,
  ClipboardCopy,
  Clock,
  FileCode,
  Info,
  Lock,
  OctagonAlert,
  RefreshCw,
  Stethoscope,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import type { Finding, IndexUsage, Severity, TableHealth } from "../lib/api";
import { analyzeTab, confirmFix, useDoctor } from "../lib/doctor";
import { useImports } from "../lib/importJobs";
import { baseId, dbOf } from "../lib/connIds";
import { useStore, type EditorTab } from "../store";
import { formatBytes } from "./LeftPanel";
import { Button, cx, DbIcon, EnvBadge, Spinner } from "./ui";

const SEV: Record<Severity, { label: string; text: string; bg: string; icon: typeof Info }> = {
  critical: { label: "Critical", text: "text-err", bg: "bg-err/15", icon: OctagonAlert },
  warning: { label: "Warning", text: "text-warn", bg: "bg-warn/15", icon: TriangleAlert },
  info: { label: "Info", text: "text-accent", bg: "bg-accent-soft", icon: Info },
};

const scoreColor = (s: number) => (s >= 80 ? "var(--ok)" : s >= 50 ? "var(--warn)" : "var(--err)");

const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());
const pct = (p: number | null | undefined) => (p == null ? "—" : `${p < 10 ? p.toFixed(1) : Math.round(p)}%`);

function ago(secs: number | null | undefined) {
  if (secs == null) return "never";
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  const d = Math.floor(secs / 86400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function TableDoctor({ tab }: { tab: EditorTab }) {
  const res = useDoctor((s) => s.byTab[tab.id]);
  const cfg = useStore((s) => s.connections.find((c) => c.id === baseId(tab.connId)));
  const [, tick] = useState(0);

  // first open (or restored tab): analyze
  useEffect(() => {
    if (!useDoctor.getState().byTab[tab.id]) void analyzeTab(tab.id);
  }, [tab.id]);

  // keeps "analyzed N s ago" current
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const d = tab.doctor!;
  const h = res?.health;
  const db = dbOf(tab.connId);
  const where = [cfg?.name, db].filter(Boolean).join(" / ");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-4 border-b border-line px-5 py-4">
        <ScoreRing score={h?.score} loading={!!res?.loading && !h} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Stethoscope size={16} className="shrink-0 text-accent" />
            <h1 className="truncate text-[16px] font-semibold">
              <span className="text-muted">{d.schema}.</span>
              {d.table}
            </h1>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-muted">
            {cfg && <DbIcon kind={cfg.kind} size={14} />}
            <span className="truncate">{where}</span>
            <EnvBadge cfg={cfg} />
            {h?.stats.engine && <span>· {h.stats.engine}</span>}
            {res?.at && <span>· analyzed {ago(Math.round((Date.now() - res.at) / 1000))}</span>}
          </div>
          {h && <Summary findings={h.findings} />}
        </div>
        <Button onClick={() => void analyzeTab(tab.id)} disabled={res?.loading} className="h-9 px-4">
          {res?.loading ? <Spinner /> : <RefreshCw size={15} />} Re-run
        </Button>
      </header>

      {res?.error && <p className="selectable mx-5 mt-4 rounded-md bg-err/10 px-3 py-2 text-[13px] text-err">{res.error}</p>}
      {!h && res?.loading && (
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted">
          <Spinner /> Reading table statistics…
        </div>
      )}

      {h && (
        <div className={cx("space-y-5 px-5 py-4 transition-opacity", res?.loading && "opacity-60")}>
          <Metrics h={h} mysql={cfg?.kind === "mysql"} />
          <Findings tabId={tab.id} findings={h.findings} fixes={res?.fixes ?? {}} />
          <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Indexes indexes={h.indexes} usageSecs={h.stats.usageSecs} mysql={cfg?.kind === "mysql"} />
            <Space h={h} mysql={cfg?.kind === "mysql"} />
          </div>
          {h.notes.length > 0 && (
            <div className="space-y-1">
              {h.notes.map((n) => (
                <p key={n} className="flex items-start gap-2 text-[12px] text-muted">
                  <Info size={13} className="mt-0.5 shrink-0" /> {n}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScoreRing({ score, loading }: { score?: number; loading: boolean }) {
  const R = 26;
  const C = 2 * Math.PI * R;
  const color = score == null ? "var(--muted)" : scoreColor(score);
  return (
    <div className="relative flex h-[64px] w-[64px] shrink-0 items-center justify-center" title="Health score: 100 minus points for each finding">
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r={R} fill="none" stroke="var(--hover)" strokeWidth="6" />
        {score != null && (
          <circle
            cx="32"
            cy="32"
            r={R}
            fill="none"
            stroke={color}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - score / 100)}
            className="transition-[stroke-dashoffset] duration-500"
          />
        )}
      </svg>
      {loading ? <Spinner size={18} /> : <span className="text-[18px] font-bold tabular-nums" style={{ color }}>{score ?? "—"}</span>}
    </div>
  );
}

function Summary({ findings }: { findings: Finding[] }) {
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  if (findings.length === 0)
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ok">
        <CircleCheck size={13} /> No problems found
      </div>
    );
  return (
    <div className="mt-1.5 flex gap-2 text-[11.5px] font-medium">
      {(["critical", "warning", "info"] as const).map((s) =>
        count(s) > 0 ? (
          <span key={s} className={cx("rounded px-1.5 py-0.5", SEV[s].bg, SEV[s].text)}>
            {count(s)} {s === "info" ? "info" : `${SEV[s].label.toLowerCase()}${count(s) > 1 ? "s" : ""}`}
          </span>
        ) : null,
      )}
    </div>
  );
}

type Tone = "ok" | "warn" | "err" | undefined;

function Metric({ label, value, sub, tone, title }: { label: string; value: string; sub?: string; tone?: Tone; title?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-3.5 py-3" title={title}>
      <div className="text-[11.5px] text-muted">{label}</div>
      <div className={cx("mt-1 text-[20px] font-semibold tabular-nums", tone === "err" ? "text-err" : tone === "warn" ? "text-warn" : "text-fg")}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11.5px] text-fg-2">{sub}</div>}
    </div>
  );
}

function Metrics({ h, mysql }: { h: TableHealth; mysql: boolean }) {
  const s = h.stats;
  const size = (s.tableBytes ?? 0) + (s.indexBytes ?? 0) + (s.toastBytes ?? 0);
  const big = (s.rows ?? 0) >= 10_000;
  const seqTone: Tone = s.seqScanPct == null || !big ? undefined : s.seqScanPct >= 90 ? "err" : s.seqScanPct >= 50 ? "warn" : "ok";
  // MySQL: unknown for MyISAM or without access to mysql.innodb_table_stats
  const analyzeUnknown = mysql && s.analyzedSecsAgo == null;
  const analyzeTone: Tone = analyzeUnknown ? undefined : s.analyzedSecsAgo == null ? (s.rows ? "warn" : undefined) : s.analyzedSecsAgo > 30 * 86400 ? "warn" : "ok";
  const freePct = mysql && size > 0 && s.freeBytes != null ? (s.freeBytes * 100) / (size + s.freeBytes) : null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <Metric label="Rows" value={num(s.rows)} sub="planner estimate" />
      <Metric
        label="Size"
        value={formatBytes(size)}
        sub={`indexes ${formatBytes(s.indexBytes ?? 0)}${s.toastBytes ? ` · TOAST ${formatBytes(s.toastBytes)}` : ""}`}
      />
      {mysql ? (
        <Metric
          label="Free space"
          value={pct(freePct)}
          sub={s.freeBytes != null ? `${formatBytes(s.freeBytes)} unused` : undefined}
          tone={freePct == null ? undefined : freePct >= 50 ? "err" : freePct >= 25 && (s.freeBytes ?? 0) >= 16 << 20 ? "warn" : "ok"}
          title="data_free: allocated but unused space in the tablespace"
        />
      ) : (
        <Metric
          label="Dead rows"
          value={pct(s.deadPct)}
          sub={s.deadRows != null ? `${num(s.deadRows)} dead · vacuum ${ago(s.vacuumedSecsAgo)}` : undefined}
          tone={s.deadPct == null ? undefined : s.deadPct >= 20 ? "err" : s.deadPct >= 10 ? "warn" : "ok"}
        />
      )}
      <Metric
        label={mysql ? "Full-scan reads" : "Seq scans"}
        value={pct(s.seqScanPct)}
        sub={
          s.seqScans == null
            ? "no statistics"
            : mysql
              ? `${num(s.seqScans)} of ${num(s.seqScans + (s.indexScans ?? 0))} rows`
              : `${num(s.seqScans)} seq · ${num(s.indexScans)} index`
        }
        tone={seqTone}
        title={mysql ? "Share of rows read by full table scans (performance_schema)" : "Share of scans that read the whole table"}
      />
      <Metric
        label="Last ANALYZE"
        value={analyzeUnknown ? "—" : ago(s.analyzedSecsAgo)}
        sub={analyzeUnknown ? "not available" : s.modifiedSinceAnalyze != null ? `${num(s.modifiedSinceAnalyze)} rows changed since` : undefined}
        tone={analyzeTone}
      />
    </div>
  );
}

function Findings({ tabId, findings, fixes }: { tabId: string; findings: Finding[]; fixes: Record<string, string> }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (findings.length === 0)
    return (
      <section className="flex items-center gap-3 rounded-lg border border-ok/40 bg-ok/10 px-4 py-3 text-[13px] text-fg">
        <CircleCheck size={18} className="text-ok" /> Nothing to fix — this table looks healthy.
      </section>
    );
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-semibold">Findings</h2>
      <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
        {findings.map((f) => (
          <FindingRow key={f.id} tabId={tabId} f={f} open={!!open[f.id]} jobId={fixes[f.id]} toggle={() => setOpen((o) => ({ ...o, [f.id]: !o[f.id] }))} />
        ))}
      </div>
    </section>
  );
}

function FindingRow({ tabId, f, open, toggle, jobId }: { tabId: string; f: Finding; open: boolean; toggle: () => void; jobId?: string }) {
  const sev = SEV[f.severity];
  const Icon = sev.icon;
  const [copied, setCopied] = useState(false);
  const openInEditor = () => {
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    if (tab && f.fix) useStore.getState().newTab({ sql: f.fix.sql, connId: tab.connId, title: `${tab.doctor?.table ?? "fix"}_fix.sql`, database: tab.database });
  };
  return (
    <div>
      <button onClick={toggle} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-hover">
        <ChevronRight size={15} className={cx("shrink-0 text-muted transition-transform", open && "rotate-90")} />
        <Icon size={16} className={cx("shrink-0", sev.text)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-fg">{f.title}</span>
          {!open && <span className="block truncate text-[12px] text-muted">{f.detail}</span>}
        </span>
        {jobId ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-accent">
            <Spinner size={12} /> Fixing…
          </span>
        ) : (
          f.fix && (
            <span className="flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-fg-2">
              <Wrench size={11} /> {f.fix.label}
            </span>
          )
        )}
        <span className={cx("shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide uppercase", sev.bg, sev.text)}>{sev.label}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line bg-panel-2 px-4 py-3 pl-[46px]">
          <p className="selectable text-[13px] leading-relaxed text-fg-2">{f.detail}</p>
          {f.evidence.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
              {f.evidence.map((e) => (
                <div key={e.label} className="contents">
                  <dt className="text-muted">{e.label}</dt>
                  <dd className="selectable truncate font-medium text-fg tabular-nums" title={e.value}>
                    {e.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {f.fix && (
            <div className="space-y-2">
              <pre className="selectable overflow-x-auto rounded-md border border-line-strong bg-bg/50 p-3 font-mono text-[12.5px] whitespace-pre-wrap text-fg">{f.fix.sql}</pre>
              {f.fix.note && (
                <p className="flex items-start gap-2 text-[12px] text-fg-2">
                  {f.fix.long ? <Clock size={13} className="mt-0.5 shrink-0 text-warn" /> : <Lock size={13} className="mt-0.5 shrink-0 text-muted" />}
                  {f.fix.note}
                </p>
              )}
              <div className="flex items-center gap-2">
                {jobId ? (
                  <Button onClick={() => useImports.getState().show(jobId)}>
                    <Spinner size={12} /> Running in background — view
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => confirmFix(tabId, f)}>
                    <Wrench size={14} /> {f.fix.label}…
                  </Button>
                )}
                <Button variant="ghost" onClick={openInEditor}>
                  <FileCode size={14} /> Open in editor
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(f.fix!.sql);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  <ClipboardCopy size={14} /> {copied ? "Copied" : "Copy SQL"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type Usage = "used" | "low" | "unused" | "unknown";
const USAGE: Record<Usage, { label: string; color: string }> = {
  used: { label: "used", color: "var(--ok)" },
  low: { label: "rarely used", color: "var(--warn)" },
  unused: { label: "never used", color: "var(--err)" },
  unknown: { label: "no statistics", color: "var(--muted)" },
};

function usageOf(ix: IndexUsage, busiest: number): Usage {
  if (ix.scans == null) return "unknown";
  if (ix.scans === 0) return "unused";
  return ix.scans < Math.max(10, busiest / 100) ? "low" : "used";
}

function Indexes({ indexes, usageSecs, mysql }: { indexes: IndexUsage[]; usageSecs: number | null; mysql: boolean }) {
  const maxBytes = Math.max(1, ...indexes.map((i) => i.bytes ?? 0));
  const busiest = Math.max(0, ...indexes.map((i) => i.scans ?? 0));
  const sized = indexes.some((i) => i.bytes != null);
  const counted = indexes.some((i) => i.scans != null);
  return (
    <section className="rounded-lg border border-line bg-panel">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3.5 py-2.5">
        <h2 className="text-[13px] font-semibold">Indexes ({indexes.length})</h2>
        <span className="text-[11.5px] text-muted">
          {sized ? "bar = size, " : ""}
          {counted ? `color = ${mysql ? "reads" : "scans"}${usageSecs != null ? ` over ${ago(usageSecs).replace(" ago", "")}` : ""}` : "usage not available"}
        </span>
        <span className="ml-auto flex gap-3 text-[11px] text-fg-2">
          {(["used", "low", "unused"] as const).map((u) => (
            <span key={u} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: USAGE[u].color }} />
              {USAGE[u].label}
            </span>
          ))}
        </span>
      </header>
      {indexes.length === 0 ? (
        <p className="px-3.5 py-4 text-[12.5px] text-muted">This table has no indexes.</p>
      ) : (
        <div className="space-y-2.5 px-3.5 py-3">
          {indexes.map((ix) => {
            const u = usageOf(ix, busiest);
            return (
              <div key={ix.name} title={ix.definition}>
                <div className="flex items-baseline gap-2 text-[12.5px]">
                  <span className="truncate font-mono text-fg">{ix.name}</span>
                  {ix.primary && <Tag>PK</Tag>}
                  {!ix.primary && ix.unique && <Tag>UNIQUE</Tag>}
                  {!ix.valid && <Tag tone="err">INVALID</Tag>}
                  <span className="truncate text-[11.5px] text-muted">({ix.columns.join(", ")})</span>
                  <span className="ml-auto shrink-0 text-[11.5px] text-fg-2 tabular-nums">
                    {ix.bytes != null && formatBytes(ix.bytes)}
                    {ix.scans != null && ` · ${ix.scans.toLocaleString()} ${mysql ? "reads" : "scans"}`}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-hover">
                  <div
                    className="h-full rounded-full"
                    style={{ width: sized ? `${Math.max(2, ((ix.bytes ?? 0) / maxBytes) * 100)}%` : "100%", background: USAGE[u].color, opacity: u === "unknown" ? 0.5 : 0.85 }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: "err" }) {
  return (
    <span className={cx("shrink-0 rounded px-1 text-[9.5px] font-bold tracking-wide", tone === "err" ? "bg-err/15 text-err" : "bg-accent-soft text-accent")}>{children}</span>
  );
}

function Space({ h, mysql }: { h: TableHealth; mysql: boolean }) {
  const s = h.stats;
  const parts = [
    { label: mysql ? "Data" : "Live rows", bytes: s.liveBytes, color: "var(--ok)" },
    { label: "Dead rows", bytes: s.deadBytes, color: "var(--err)" },
    { label: "Free space", bytes: s.freeBytes, color: "var(--warn)" },
  ].filter((p) => p.bytes != null) as { label: string; bytes: number; color: string }[];
  const total = parts.reduce((a, p) => a + p.bytes, 0);
  return (
    <section className="rounded-lg border border-line bg-panel">
      <header className="border-b border-line px-3.5 py-2.5">
        <h2 className="text-[13px] font-semibold">Table space</h2>
      </header>
      <div className="space-y-3 px-3.5 py-3">
        {total === 0 ? (
          <p className="text-[12.5px] text-muted">{parts.length === 0 ? "No column statistics yet — run ANALYZE to estimate this." : "The table is empty."}</p>
        ) : (
          <>
            <div className="flex h-4 overflow-hidden rounded-full bg-hover">
              {parts.map((p) => (
                <div key={p.label} style={{ width: `${(p.bytes / total) * 100}%`, background: p.color }} title={`${p.label}: ${formatBytes(p.bytes)}`} />
              ))}
            </div>
            <div className="space-y-1 text-[12.5px]">
              {parts.map((p) => (
                <div key={p.label} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
                  <span className="text-fg-2">{p.label}</span>
                  <span className="ml-auto text-fg tabular-nums">{formatBytes(p.bytes)}</span>
                  <span className="w-12 text-right text-muted tabular-nums">{pct((p.bytes / total) * 100)}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <p className="text-[11.5px] text-muted">
          {mysql
            ? "From information_schema: data_length and data_free."
            : "Estimated from row counts and column widths; TOAST and indexes are not included."}
        </p>
      </div>
    </section>
  );
}

