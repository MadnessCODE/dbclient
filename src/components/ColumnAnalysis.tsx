// Table Doctor: value distribution of one column, and whether an index on it can narrow a filter.
import { useState } from "react";
import { BarChart3, Info, RefreshCw, TriangleAlert, Wrench } from "lucide-react";
import { api, errorText, type ColumnStats } from "../lib/api";
import { confirmAnalyze, type DoctorRef } from "../lib/doctor";
import { Select } from "./Select";
import { Button, cx, IconButton, Spinner } from "./ui";

const pct = (p: number) => `${p === 0 ? 0 : p < 1 ? p.toFixed(2) : p < 10 ? p.toFixed(1) : Math.round(p)}%`;

export function ColumnAnalysis({ r, columns, kind }: { r: DoctorRef; columns: { name: string; dataType: string }[]; kind: "postgres" | "mysql" }) {
  const [column, setColumn] = useState("");
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<ColumnStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (name: string) => {
    setColumn(name);
    setLoading(true);
    setError(null);
    try {
      setStats(await api.columnStats(r.connId, r.schema, r.table, name));
    } catch (e) {
      setStats(null);
      setError(errorText(e));
    }
    setLoading(false);
  };

  return (
    <section className="rounded-lg border border-line bg-panel">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-3.5 py-2.5">
        <BarChart3 size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold">Column values</h2>
        <span className="text-[11.5px] text-muted">{kind === "mysql" ? "from a sample of the table" : "from the planner's statistics (pg_stats)"}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Select
            className="w-[260px]"
            value={column}
            onChange={(v) => void load(v)}
            options={[{ value: "", label: "Pick a column…" }, ...columns.map((c) => ({ value: c.name, hint: c.dataType }))]}
          />
          <IconButton title="Read again" disabled={!column || loading} onClick={() => void load(column)}>
            <RefreshCw size={14} />
          </IconButton>
        </div>
      </header>
      <div className="px-3.5 py-3">
        {loading ? (
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
            <Spinner /> Reading values…
          </div>
        ) : error ? (
          <p className="selectable text-[12.5px] text-err">{error}</p>
        ) : !stats || !column ? (
          <p className="text-[12.5px] text-muted">Pick a column to see how its values are spread, and whether an index on it can narrow down a filter.</p>
        ) : (
          <ColumnView r={r} kind={kind} column={column} s={stats} />
        )}
      </div>
    </section>
  );
}

function ColumnView({ r, kind, column, s }: { r: DoctorRef; kind: "postgres" | "mysql"; column: string; s: ColumnStats }) {
  if (s.missing) {
    return kind === "postgres" ? (
      <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-fg-2">
        <Info size={14} className="text-muted" />
        No statistics for {column} yet. ANALYZE collects them (it reads a sample of the table).
        <Button onClick={() => confirmAnalyze(r, kind)}>
          <Wrench size={13} /> Analyze…
        </Button>
      </div>
    ) : (
      <p className="text-[12.5px] text-muted">The table is empty.</p>
    );
  }
  const known = s.common.reduce((a, c) => a + c.pct, 0);
  const rest = Math.max(0, 100 - known - (s.nullPct ?? 0));
  const top = s.common[0];
  const rows = s.rows ?? 0;
  const lowSelectivity = (s.distinct != null && s.distinct <= 10) || (top?.pct ?? 0) >= 20;
  const max = Math.max(1, ...s.common.map((c) => c.pct), s.nullPct ?? 0, rest);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-8 gap-y-1 text-[12.5px]">
        <Stat label="Distinct values" value={s.distinct == null ? "—" : s.distinct.toLocaleString()} />
        <Stat label="NULL" value={s.nullPct == null ? "—" : pct(s.nullPct)} />
        <Stat label={kind === "mysql" ? "Rows sampled" : "Rows (estimate)"} value={rows.toLocaleString()} />
        <Stat label="Indexed by" value={s.indexes.length ? s.indexes.join(", ") : "no index starts with it"} />
      </div>

      {s.common.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11.5px] text-muted">Most common values (share of all rows)</div>
          {s.common.map((c, i) => (
            <Bar key={i} label={c.value} pct={c.pct} max={max} tone={c.pct >= 20 ? "warn" : "ok"} />
          ))}
          {(s.nullPct ?? 0) > 0 && <Bar label={null} pct={s.nullPct!} max={max} tone="muted" />}
          {rest >= 0.5 && <Bar label="all other values" plain pct={rest} max={max} tone="muted" />}
        </div>
      )}

      {s.histogram.length > 1 && (
        <p className="text-[12px] text-fg-2">
          The other values are spread over {s.histogram.length - 1} equal-sized ranges from <code className="font-mono">{s.histogram[0]}</code> to{" "}
          <code className="font-mono">{s.histogram[s.histogram.length - 1]}</code>.
        </p>
      )}

      {s.indexes.length > 0 && lowSelectivity ? (
        <p className="flex items-start gap-2 rounded-md bg-warn/10 px-3 py-2 text-[12.5px] leading-relaxed text-fg">
          <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" />
          <span>
            An index on {column} helps only for its rare values.{" "}
            {top && (
              <>
                <b>{top.value ?? "NULL"}</b> alone is {pct(top.pct)} of the rows,{" "}
              </>
            )}
            so a filter on a common value matches a big part of the table and the database reads it whole instead of using the index. A partial index on the rare
            values, or a composite index that starts with a more selective column, works better.
          </span>
        </p>
      ) : s.indexes.length === 0 && lowSelectivity ? (
        <p className="flex items-start gap-2 text-[12.5px] text-fg-2">
          <Info size={14} className="mt-0.5 shrink-0 text-muted" />
          Few distinct values: an index on {column} alone would not narrow most filters.
        </p>
      ) : s.distinct != null && rows > 0 && s.distinct >= rows * 0.5 ? (
        <p className="flex items-start gap-2 text-[12.5px] text-fg-2">
          <Info size={14} className="mt-0.5 shrink-0 text-ok" />
          Very selective: almost every value is rare, so an index on {column} narrows a filter well.
        </p>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11.5px] text-muted">{label}</div>
      <div className="font-medium text-fg tabular-nums">{value}</div>
    </div>
  );
}

function Bar({ label, pct: p, max, tone, plain }: { label: string | null; pct: number; max: number; tone: "ok" | "warn" | "muted"; plain?: boolean }) {
  const color = tone === "warn" ? "var(--warn)" : tone === "ok" ? "var(--accent)" : "var(--muted)";
  return (
    <div className="flex items-center gap-3 text-[12px]">
      <span className={cx("w-[180px] shrink-0 truncate", plain ? "text-muted" : label == null ? "text-muted italic" : "font-mono text-fg")} title={label ?? "NULL"}>
        {label ?? "NULL"}
      </span>
      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-hover">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(0.5, (p / max) * 100)}%`, background: color, opacity: tone === "muted" ? 0.5 : 0.85 }} />
      </span>
      <span className="w-14 shrink-0 text-right text-fg-2 tabular-nums">{pct(p)}</span>
    </div>
  );
}
