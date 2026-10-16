// Date / time / datetime picker, with a time zone for Postgres timestamptz and timetz.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Clock, Globe } from "lucide-react";
import { cx } from "./ui";

export type DateKind = "date" | "datetime" | "time";

interface Parts {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
  /** Fractional seconds as a string ("345") */
  frac: string;
  /** "+02:00", "-05:30"; null = no zone */
  tz: string | null;
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");

/** Local UTC offset, e.g. "+02:00". */
function localOffset(date = new Date()): string {
  const min = -date.getTimezoneOffset();
  return `${min >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`;
}

/** "+02" / "+0530" / "Z" -> "+02:00" / "+05:30" / "+00:00" */
function normTz(tz: string): string {
  if (tz === "Z") return "+00:00";
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(tz);
  return m ? `${m[1]}${m[2]}:${m[3] ?? "00"}` : tz;
}

const DT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const T_RE = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** Parses a value; null if the picker can't show it ('infinity', '-838:59:59'). */
export function parseDateValue(kind: DateKind, v: string): Parts | null {
  const t = v.trim();
  if (kind === "time") {
    const m = T_RE.exec(t);
    if (!m || Number(m[1]) > 23) return null;
    return { y: 2000, m: 1, d: 1, h: Number(m[1]), mi: Number(m[2]), s: Number(m[3] ?? 0), frac: m[4] ?? "", tz: m[5] ? normTz(m[5]) : null };
  }
  const m = DT_RE.exec(t);
  if (!m) return null;
  return {
    y: Number(m[1]),
    m: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4] ?? 0),
    mi: Number(m[5] ?? 0),
    s: Number(m[6] ?? 0),
    frac: m[7] ?? "",
    tz: m[8] ? normTz(m[8]) : null,
  };
}

/** Formats parts as "2025-09-01 10:24:12.345+02:00". */
export function formatDateValue(kind: DateKind, p: Parts, withTz: boolean): string {
  const date = `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
  const time = `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${p.frac ? `.${p.frac}` : ""}`;
  const tz = withTz && p.tz ? p.tz : "";
  if (kind === "date") return date;
  if (kind === "time") return `${time}${tz}`;
  return `${date} ${time}${tz}`;
}

function nowParts(kind: DateKind, withTz: boolean): Parts {
  const n = new Date();
  return {
    y: n.getFullYear(),
    m: n.getMonth() + 1,
    d: n.getDate(),
    h: kind === "date" ? 0 : n.getHours(),
    mi: kind === "date" ? 0 : n.getMinutes(),
    s: kind === "date" ? 0 : n.getSeconds(),
    frac: "",
    tz: withTz ? localOffset(n) : null,
  };
}

/** Postgres special date values */
const INF_RE = /^[+-]?infinity$/i;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Local zone plus the common UTC offsets. */
const TZ_OPTIONS = (() => {
  const list: string[] = [];
  for (let h = -12; h <= 14; h++) list.push(`${h < 0 ? "-" : "+"}${pad(Math.abs(h))}:00`);
  list.push("+05:30", "+05:45", "+09:30", "+03:30", "+04:30", "+06:30", "-03:30", "+10:30", "+12:45");
  return [...new Set(list)].sort((a, b) => toMin(a) - toMin(b));
})();
function toMin(tz: string) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

export function DateTimePicker({
  kind,
  withTz,
  value,
  allowInfinity = false,
  applyUnchanged = false,
  anchor,
  onApply,
  onCancel,
}: {
  kind: DateKind;
  withTz: boolean;
  value: string | null;
  /** Postgres date/timestamp: offer -infinity / +infinity */
  allowInfinity?: boolean;
  /** Apply / Enter return the shown value even when it wasn't changed (filters start from "now") */
  applyUnchanged?: boolean;
  /** Anchor element */
  anchor: HTMLElement | null;
  onApply: (v: string | null) => void;
  onCancel: () => void;
}) {
  const initial = useMemo(() => {
    const p = value ? parseDateValue(kind, value) : null;
    const base = p ?? nowParts(kind, withTz);
    if (withTz && !base.tz) base.tz = value ? "+00:00" : localOffset();
    return base;
  }, [kind, value, withTz]);

  const [parts, setParts] = useState<Parts>(initial);
  const [view, setView] = useState({ y: initial.y, m: initial.m });
  const [picking, setPicking] = useState<"days" | "months">("days");
  const [text, setText] = useState(() => (value && !parseDateValue(kind, value) ? value : formatDateValue(kind, initial, withTz)));
  const [textError, setTextError] = useState(false);
  const infinite = allowInfinity && INF_RE.test(text.trim());
  /** Closing without changes doesn't produce an edit */
  const [dirty, setDirty] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const showDate = kind !== "time";
  const showTime = kind !== "date";

  // below the cell, or above when there's no room
  useLayoutEffect(() => {
    if (!anchor || !panel.current) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.current.getBoundingClientRect();
    const below = a.bottom + 4 + p.height <= window.innerHeight;
    setPos({
      left: Math.max(8, Math.min(a.left, window.innerWidth - p.width - 8)),
      top: below ? a.bottom + 4 : Math.max(8, a.top - p.height - 4),
    });
  }, [anchor]);

  // click outside = apply
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) apply();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  });

  const update = (patch: Partial<Parts>) => {
    setDirty(true);
    setParts((p) => {
      const next = { ...p, ...patch };
      const days = new Date(next.y, next.m, 0).getDate();
      if (next.d > days) next.d = days;
      setText(formatDateValue(kind, next, withTz));
      setTextError(false);
      return next;
    });
  };

  const apply = (confirmed = false) => {
    if (!dirty && !(confirmed && applyUnchanged)) return onCancel();
    if (allowInfinity && INF_RE.test(text.trim())) {
      const inf = text.trim().toLowerCase().replace(/^\+/, "");
      return inf === (value ?? "").trim().toLowerCase() ? onCancel() : onApply(inf);
    }
    // text the picker can't parse (e.g. 'infinity') is sent as is
    const p = parseDateValue(kind, text);
    if (!p) return text.trim() ? onApply(text.trim()) : onApply(null);
    const next = formatDateValue(kind, p, withTz);
    // same value written differently ("+00" vs "+00:00"): keep the original
    const orig = value ? parseDateValue(kind, value) : null;
    if (orig && formatDateValue(kind, { ...orig, tz: withTz ? (orig.tz ?? p.tz) : null }, withTz) === next) return onCancel();
    onApply(next);
  };

  const onTextChange = (v: string) => {
    setDirty(true);
    setText(v);
    const p = parseDateValue(kind, v);
    setTextError(!p && v.trim() !== "" && !(allowInfinity && INF_RE.test(v.trim())));
    if (p) {
      setParts({ ...p, tz: withTz ? (p.tz ?? parts.tz) : null });
      if (showDate) setView({ y: p.y, m: p.m });
    }
  };

  // month grid, weeks start on Monday
  const grid = useMemo(() => {
    const first = new Date(view.y, view.m - 1, 1);
    const lead = (first.getDay() + 6) % 7;
    const days = new Date(view.y, view.m, 0).getDate();
    const prevDays = new Date(view.y, view.m - 1, 0).getDate();
    const cells: { y: number; m: number; d: number; out: boolean }[] = [];
    for (let i = lead - 1; i >= 0; i--) {
      const pm = view.m === 1 ? 12 : view.m - 1;
      cells.push({ y: view.m === 1 ? view.y - 1 : view.y, m: pm, d: prevDays - i, out: true });
    }
    for (let d = 1; d <= days; d++) cells.push({ y: view.y, m: view.m, d, out: false });
    while (cells.length % 7 !== 0 || cells.length < 42) {
      const n = cells.length - lead - days + 1;
      cells.push({ y: view.m === 12 ? view.y + 1 : view.y, m: view.m === 12 ? 1 : view.m + 1, d: n, out: true });
    }
    return cells;
  }, [view]);

  const today = new Date();
  const isToday = (c: { y: number; m: number; d: number }) => c.y === today.getFullYear() && c.m === today.getMonth() + 1 && c.d === today.getDate();
  const isSel = (c: { y: number; m: number; d: number }) => !infinite && c.y === parts.y && c.m === parts.m && c.d === parts.d;
  const shiftMonth = (delta: number) => setView((v) => {
    const t = v.m - 1 + delta;
    return { y: v.y + Math.floor(t / 12), m: ((t % 12) + 12) % 12 + 1 };
  });

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      apply(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return createPortal(
    <div
      ref={panel}
      onKeyDown={onKey}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      className="fixed z-[70] w-[308px] rounded-xl border border-line-strong bg-raised p-3 shadow-2xl shadow-black/50"
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        spellCheck={false}
        className={cx(
          "mb-3 h-9 w-full rounded-lg border bg-bg/50 px-3 font-mono text-[13px] text-fg outline-none focus:border-accent",
          textError ? "border-warn" : infinite ? "border-accent/60 text-accent" : "border-line-strong",
        )}
        title={textError ? "Not a regular date; it will be saved exactly as typed" : "You can also type the value"}
      />
      {infinite && (
        <p className="-mt-1.5 mb-3 text-[11.5px] text-muted">
          {text.trim().startsWith("-") ? "−∞ earlier than any date." : "+∞ later than any date."} Pick a day to replace it.
        </p>
      )}

      {showDate && (
        <>
          <div className="mb-2 flex items-center justify-between">
            <button onClick={() => (picking === "days" ? shiftMonth(-1) : setView((v) => ({ ...v, y: v.y - 1 })))} className="flex h-7 w-7 items-center justify-center rounded-md text-fg-2 hover:bg-hover">
              <ChevronLeft size={16} />
            </button>
            <button onClick={() => setPicking(picking === "days" ? "months" : "days")} className="rounded-md px-2 py-1 text-[13px] font-semibold hover:bg-hover">
              {picking === "days" ? `${MONTHS[view.m - 1]} ${view.y}` : view.y}
            </button>
            <button onClick={() => (picking === "days" ? shiftMonth(1) : setView((v) => ({ ...v, y: v.y + 1 })))} className="flex h-7 w-7 items-center justify-center rounded-md text-fg-2 hover:bg-hover">
              <ChevronRight size={16} />
            </button>
          </div>

          {picking === "days" ? (
            <div className="grid grid-cols-7 gap-0.5 text-center">
              {WEEKDAYS.map((w) => (
                <div key={w} className="pb-1 text-[10.5px] font-medium tracking-wide text-muted uppercase">
                  {w}
                </div>
              ))}
              {grid.map((c, i) => (
                <button
                  key={i}
                  onClick={() => {
                    update({ y: c.y, m: c.m, d: c.d });
                    if (c.out) setView({ y: c.y, m: c.m });
                  }}
                  onDoubleClick={() => kind === "date" && apply()}
                  className={cx(
                    "h-8 rounded-lg text-[12.5px] tabular-nums transition-colors",
                    isSel(c) ? "bg-accent font-semibold text-white" : c.out ? "text-muted/50 hover:bg-hover" : "text-fg hover:bg-hover",
                    !isSel(c) && isToday(c) && "ring-1 ring-accent/60 ring-inset",
                  )}
                >
                  {c.d}
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {MONTHS.map((name, i) => (
                <button
                  key={name}
                  onClick={() => {
                    setView((v) => ({ ...v, m: i + 1 }));
                    update({ y: view.y, m: i + 1 });
                    setPicking("days");
                  }}
                  className={cx("h-10 rounded-lg text-[12.5px]", parts.m === i + 1 && parts.y === view.y ? "bg-accent text-white" : "hover:bg-hover")}
                >
                  {name.slice(0, 3)}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {showTime && (
        <div className={cx("space-y-2", showDate && "mt-3 border-t border-line pt-3")}>
          {/* time fields span the full width */}
          <div className="flex items-center gap-2">
            <Clock size={15} className="shrink-0 text-muted" />
            <TimeField value={parts.h} max={23} onChange={(h) => update({ h })} />
            <span className="text-muted">:</span>
            <TimeField value={parts.mi} max={59} onChange={(mi) => update({ mi })} />
            <span className="text-muted">:</span>
            <TimeField value={parts.s} max={59} onChange={(s) => update({ s })} />
            {parts.frac !== "" && (
              <>
                <span className="text-muted">.</span>
                <input
                  value={parts.frac}
                  onChange={(e) => update({ frac: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                  className="h-9 min-w-0 flex-1 rounded-md border border-line-strong bg-bg/50 text-center font-mono text-[13px] text-fg outline-none focus:border-accent"
                  title="Fraction of a second"
                />
              </>
            )}
          </div>
          {withTz && (
            <label className="flex items-center gap-2 text-[12px] text-muted" title="Time zone offset sent to PostgreSQL">
              <Globe size={15} className="shrink-0" />
              <select
                value={parts.tz ?? "+00:00"}
                onChange={(e) => update({ tz: e.target.value })}
                className="h-9 min-w-0 flex-1 rounded-md border border-line-strong bg-panel px-2 font-mono text-[12.5px] text-fg outline-none focus:border-accent"
              >
                <option value={localOffset()}>Local {localOffset()}</option>
                {!TZ_OPTIONS.includes(parts.tz ?? "") && parts.tz && <option value={parts.tz}>UTC{parts.tz}</option>}
                {TZ_OPTIONS.map((tz) => (
                  <option key={tz} value={tz}>
                    UTC{tz === "+00:00" ? "" : tz}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-1.5">
        <button
          onClick={() => {
            const n = nowParts(kind, withTz);
            update({ ...n, frac: "" });
            setView({ y: n.y, m: n.m });
          }}
          className="rounded-md px-2 py-1.5 text-[12px] text-accent hover:bg-accent-soft"
        >
          {kind === "date" ? "Today" : "Now"}
        </button>
        {allowInfinity && (
          <>
            <button
              title="-infinity (before every date)"
              onClick={() => onTextChange("-infinity")}
              className={cx("rounded-md px-2 py-1.5 text-[13px] hover:bg-hover", text.trim() === "-infinity" ? "bg-accent-soft text-accent" : "text-fg-2")}
            >
              −∞
            </button>
            <button
              title="infinity (after every date)"
              onClick={() => onTextChange("infinity")}
              className={cx("rounded-md px-2 py-1.5 text-[13px] hover:bg-hover", /^\+?infinity$/.test(text.trim()) ? "bg-accent-soft text-accent" : "text-fg-2")}
            >
              +∞
            </button>
          </>
        )}
        <div className="flex-1" />
        <button onClick={onCancel} className="rounded-md px-3 py-1.5 text-[12.5px] text-fg-2 hover:bg-hover">
          Cancel
        </button>
        <button onClick={() => apply(true)} className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-accent-hover">
          Apply
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** Hour/minute/second field: typing, arrow keys and mouse wheel. */
function TimeField({ value, max, onChange }: { value: number; max: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const wrap = (v: number) => ((v % (max + 1)) + (max + 1)) % (max + 1);
  return (
    <input
      value={draft ?? pad(value)}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, "").slice(-2);
        setDraft(digits);
        if (digits !== "" && Number(digits) <= max) onChange(Number(digits));
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          setDraft(null);
          onChange(wrap(value + (e.key === "ArrowUp" ? 1 : -1)));
        }
      }}
      onWheel={(e) => {
        setDraft(null);
        onChange(wrap(value + (e.deltaY < 0 ? 1 : -1)));
      }}
      className="h-9 min-w-0 flex-1 rounded-md border border-line-strong bg-bg/50 text-center font-mono text-[14px] text-fg tabular-nums outline-none focus:border-accent"
    />
  );
}
