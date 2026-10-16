// Grid filter bar (chips, AND/OR, manual WHERE) and the per-column filter popover.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, FileInput, Filter, Plus, X } from "lucide-react";
import type { Cell } from "../lib/api";
import { formatEpoch, isTruthy, looksNumeric, type CellKind, type TsUnit } from "../lib/cellKind";
import {
  filterLabel,
  needsValue,
  OP_LABEL,
  opsFor,
  RANGE_LABELS,
  type ColumnFilter,
  type DateRange,
  type FilterOp,
  type GridFilters,
} from "../lib/filter";
import { DateTimePicker, parseDateValue, type DateKind } from "./DateTimePicker";
import { cx, Spinner } from "./ui";

export interface FilterColumn {
  name: string;
  kind: CellKind;
  typeName: string;
  ts: TsUnit | null;
  enumValues?: string[];
}

export type TopValue = { value: Cell; n: string };

/** Fixed position under (or above) an anchor rectangle, kept inside the window. */
function usePlacement(anchor: DOMRect, panel: React.RefObject<HTMLDivElement | null>, deps: unknown[] = []) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!panel.current) return;
    const p = panel.current.getBoundingClientRect();
    const below = anchor.bottom + 4 + p.height <= window.innerHeight;
    setPos({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - p.width - 8)),
      top: below ? anchor.bottom + 4 : Math.max(8, anchor.top - p.height - 4),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, ...deps]);
  return pos;
}

export function FilterBar({
  filters,
  columns,
  generated,
  status,
  onChange,
  onEdit,
  onAdd,
  onToEditor,
  quote,
}: {
  filters: GridFilters | undefined;
  columns: FilterColumn[];
  /** Column name as written in SQL */
  quote: (name: string) => string;
  /** Generated condition, shown under the bar */
  generated: string | null;
  status: string;
  onChange: (next: GridFilters) => void;
  onEdit: (f: ColumnFilter, anchor: DOMRect) => void;
  onAdd: (col: number, anchor: DOMRect) => void;
  onToEditor: () => void;
}) {
  const items = filters?.items ?? [];
  const join = filters?.join ?? "and";
  const active = items.length > 0 || !!filters?.where.trim();
  const [picking, setPicking] = useState<DOMRect | null>(null);
  const empty = (): GridFilters => filters ?? { base: "", items: [], join: "and", where: "" };

  return (
    <div className="mx-3 mb-1.5">
      <div className="flex min-h-8 flex-wrap items-center gap-1.5 text-[12px]">
        <Filter size={13} className={cx("shrink-0", active ? "text-accent" : "text-muted")} />
        {items.map((f, i) => (
          <span key={f.id} className="flex items-center gap-1">
            {i > 0 && <span className="text-[10.5px] font-semibold text-muted uppercase">{join}</span>}
            <span className="flex h-6 max-w-[320px] items-center rounded-full border border-accent/40 bg-accent-soft text-fg">
              <button
                onClick={(e) => onEdit(f, e.currentTarget.getBoundingClientRect())}
                className="truncate rounded-l-full pr-1 pl-2.5 font-mono text-[11.5px] hover:text-accent"
                title="Edit filter"
              >
                {filterLabel(f)}
              </button>
              <button
                title="Remove filter"
                onClick={() => onChange({ ...empty(), items: items.filter((x) => x.id !== f.id) })}
                className="mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg"
              >
                <X size={12} />
              </button>
            </span>
          </span>
        ))}
        <button
          onClick={(e) => setPicking(e.currentTarget.getBoundingClientRect())}
          className="flex h-6 items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 text-fg-2 hover:border-accent hover:text-accent"
          title="Filter by a column (or right-click a cell / Alt+click a value)"
        >
          <Plus size={12} /> Filter
        </button>
        {items.length > 1 && (
          <span className="flex h-6 overflow-hidden rounded-md border border-line-strong text-[11px] font-semibold">
            {(["and", "or"] as const).map((j) => (
              <button
                key={j}
                onClick={() => j !== join && onChange({ ...empty(), join: j })}
                className={cx("px-2 uppercase", j === join ? "bg-accent text-white" : "text-fg-2 hover:bg-hover")}
                title={j === "and" ? "Rows matching all filters" : "Rows matching any filter"}
              >
                {j}
              </button>
            ))}
          </span>
        )}
        <WhereInput value={filters?.where ?? ""} columns={columns.map((c) => c.name)} quote={quote} onApply={(where) => onChange({ ...empty(), where })} />
        {active && (
          <>
            <button onClick={onToEditor} className="flex h-6 items-center gap-1 rounded px-1.5 text-fg-2 hover:bg-hover hover:text-fg" title="Write the filtered query into the editor">
              <FileInput size={13} /> To editor
            </button>
            <button onClick={() => onChange({ ...empty(), items: [], where: "" })} className="flex h-6 items-center gap-1 rounded px-1.5 text-accent hover:bg-accent-soft">
              <X size={12} /> Clear
            </button>
          </>
        )}
      </div>
      {active && generated && (
        <div className="mt-1 flex items-center gap-2 border-t border-line/60 pt-1 text-[11px] text-muted">
          <span className="min-w-0 truncate font-mono" title={generated}>
            WHERE {generated}
          </span>
          <span className="ml-auto shrink-0">{status}</span>
        </div>
      )}
      {picking && (
        <ColumnPicker
          anchor={picking}
          columns={columns}
          onPick={(i) => {
            setPicking(null);
            onAdd(i, picking);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}

/** Free WHERE condition with column-name completion; Enter applies. */
function WhereInput({ value, columns, quote, onApply }: { value: string; columns: string[]; quote: (name: string) => string; onApply: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [caret, setCaret] = useState(0);
  const [hi, setHi] = useState(0);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setText(value), [value]);

  const word = /[\w$]+$/.exec(text.slice(0, caret))?.[0] ?? "";
  const suggestions = useMemo(() => {
    if (!word || !focused) return [];
    const w = word.toLowerCase();
    return columns.filter((c) => c.toLowerCase().includes(w) && c.toLowerCase() !== w).sort((a, b) => Number(!a.toLowerCase().startsWith(w)) - Number(!b.toLowerCase().startsWith(w))).slice(0, 8);
  }, [word, columns, focused]);

  const accept = (name: string) => {
    const start = caret - word.length;
    const ident = quote(name);
    const next = text.slice(0, start) + ident + text.slice(caret);
    setText(next);
    const pos = start + ident.length;
    setCaret(pos);
    requestAnimationFrame(() => ref.current?.setSelectionRange(pos, pos));
  };

  const dirty = text.trim() !== value.trim();
  return (
    <div className="relative flex h-6 min-w-[220px] flex-1 items-center rounded-md border border-line-strong bg-bg/40 focus-within:border-accent">
      <span className="pl-2 font-mono text-[11px] font-semibold text-muted">WHERE</span>
      <input
        ref={ref}
        value={text}
        spellCheck={false}
        placeholder="condition, e.g. price > 100 and name like 'A%'"
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setHi(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
          } else if (suggestions.length && e.key === "Tab") {
            e.preventDefault();
            accept(suggestions[hi]);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (suggestions.length && word && hi >= 0 && e.altKey) accept(suggestions[hi]);
            else onApply(text.trim());
          } else if (e.key === "Escape") {
            setText(value);
            ref.current?.blur();
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-[11.5px] text-fg outline-none placeholder:font-sans placeholder:text-muted/70"
      />
      {dirty && <span className="pr-2 text-[10.5px] text-warn">Enter to apply</span>}
      {suggestions.length > 0 && (
        <div className="absolute top-full left-12 z-40 mt-1 min-w-[180px] rounded-md border border-line-strong bg-raised p-1 shadow-xl">
          {suggestions.map((s, i) => (
            <button
              key={s}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s);
              }}
              onMouseEnter={() => setHi(i)}
              className={cx("block w-full rounded px-2 py-1 text-left font-mono text-[12px]", i === hi ? "bg-accent-soft text-fg" : "text-fg-2")}
            >
              {s}
            </button>
          ))}
          <div className="border-t border-line px-2 pt-1 text-[10.5px] text-muted">Tab to insert</div>
        </div>
      )}
    </div>
  );
}

function ColumnPicker({ anchor, columns, onPick, onClose }: { anchor: DOMRect; columns: FilterColumn[]; onPick: (i: number) => void; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const shown = columns.map((c, i) => ({ c, i })).filter(({ c }) => c.name.toLowerCase().includes(q.toLowerCase()));
  const pos = usePlacement(anchor, panel);
  useOutside(panel, onClose);
  return createPortal(
    <div
      ref={panel}
      style={pos ?? { visibility: "hidden", left: 0, top: 0 }}
      className="fixed z-[70] w-[260px] rounded-lg border border-line-strong bg-raised p-1.5 shadow-2xl shadow-black/50"
    >
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setHi((h) => Math.min(shown.length - 1, h + 1));
          else if (e.key === "ArrowUp") setHi((h) => Math.max(0, h - 1));
          else if (e.key === "Enter" && shown[hi]) onPick(shown[hi].i);
          else if (e.key === "Escape") onClose();
        }}
        placeholder="Column…"
        spellCheck={false}
        className="mb-1 h-7 w-full rounded-md border border-line-strong bg-bg/40 px-2 text-[12.5px] text-fg outline-none focus:border-accent"
      />
      <div className="max-h-[300px] overflow-auto">
        {shown.map(({ c, i }, k) => (
          <button
            key={i}
            onClick={() => onPick(i)}
            onMouseEnter={() => setHi(k)}
            className={cx("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12.5px]", k === hi ? "bg-accent-soft text-fg" : "text-fg-2")}
          >
            <span className="truncate">{c.name}</span>
            <span className="ml-auto shrink-0 text-[11px] text-muted">{c.ts ? "timestamp" : c.typeName}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function useOutside(panel: React.RefObject<HTMLDivElement | null>, onClose: () => void, disabled = false) {
  useEffect(() => {
    if (disabled) return;
    const onDown = (e: MouseEvent) => !panel.current?.contains(e.target as Node) && onClose();
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [panel, onClose, disabled]);
}

const isDate = (k: CellKind) => k === "date" || k === "datetime" || k === "time";

/** Picker text ("2025-09-01 10:24:12+02:00", local without a zone) to a Unix timestamp. */
function toEpoch(v: string, unit: TsUnit): string | null {
  const t = v.trim();
  if (/^\d+$/.test(t)) return t;
  const p = parseDateValue("datetime", t);
  if (!p) return null;
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(p.tz ?? "");
  const frac = Math.round(Number(`0.${p.frac || "0"}`) * 1000);
  const ms = m
    ? Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) + frac - (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000
    : new Date(p.y, p.m - 1, p.d, p.h, p.mi, p.s, frac).getTime();
  return String(unit === "s" ? Math.floor(ms / 1000) : ms);
}

const fromEpoch = (v: string | undefined, unit: TsUnit) => (v && /^\d+$/.test(v) ? formatEpoch(Number(v) * (unit === "s" ? 1000 : 1)) : (v ?? ""));

/** Filter editor for one column, adapted to its type. */
export function FilterPopover({
  column,
  initial,
  anchor,
  isNew,
  loadTop,
  onApply,
  onRemove,
  onClose,
}: {
  column: FilterColumn;
  /** Filter being edited, or a new one with defaults */
  initial: ColumnFilter;
  anchor: DOMRect;
  isNew: boolean;
  loadTop?: () => Promise<TopValue[]>;
  onApply: (f: ColumnFilter) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const { kind, ts } = column;
  const ops = opsFor(kind, ts);
  const [op, setOp] = useState<FilterOp>(ops.includes(initial.op) ? initial.op : ops[0]);
  const shown = (v: string | undefined) => (ts ? fromEpoch(v, ts) : (v ?? ""));
  const [value, setValue] = useState(shown(initial.value));
  const [value2, setValue2] = useState(shown(initial.value2));
  const [values, setValues] = useState<string[]>(initial.values ?? (initial.op === "in" && initial.value ? [initial.value] : []));
  const [listText, setListText] = useState("");
  const [picker, setPicker] = useState<{ which: 1 | 2; el: HTMLElement } | null>(null);
  const [top, setTop] = useState<TopValue[] | "loading" | "error" | null>(loadTop ? "loading" : null);
  const panel = useRef<HTMLDivElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const pos = usePlacement(anchor, panel, [top === "loading"]);
  useOutside(panel, onClose, !!picker);

  useEffect(() => {
    if (!loadTop) return;
    let alive = true;
    loadTop().then(
      (v) => alive && setTop(v),
      () => alive && setTop("error"),
    );
    return () => {
      alive = false;
    };
  }, [loadTop]);
  useEffect(() => {
    firstInput.current?.focus();
    firstInput.current?.select();
  }, [op]);

  const numeric = (kind === "number" || kind === "year") && !ts;
  const badNum = (v: string) => numeric && v.trim() !== "" && !looksNumeric(v);
  const conv = (v: string) => (ts ? toEpoch(v, ts) : v.trim() === "" && kind !== "text" ? null : v);

  const build = (o: FilterOp = op, extra: Partial<ColumnFilter> = {}): ColumnFilter | null => {
    const f: ColumnFilter = { ...initial, op: o, value: undefined, value2: undefined, values: undefined, range: undefined, ...extra };
    if (o === "in") {
      const all = [...values, ...listText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)];
      const vals = all.map((v) => (ts ? toEpoch(v, ts) : v)).filter((v): v is string => v !== null);
      if (!vals.length || vals.some(badNum)) return null;
      return { ...f, values: [...new Set(vals)] };
    }
    if (o === "range" || !needsValue(o)) return f;
    const a = conv(value);
    if (a === null || badNum(a)) return null;
    if (o === "between") {
      const b = conv(value2);
      if (b === null || badNum(b)) return null;
      return { ...f, value: a, value2: b };
    }
    return { ...f, value: a };
  };
  const result = build();
  const apply = (f: ColumnFilter | null = result) => f && onApply(f);

  const pickTop = (v: Cell) => {
    if (v === null) return apply(build("null"));
    const s = ts ? fromEpoch(v, ts) : v;
    if (op === "in") return setValues((vs) => (vs.includes(s) ? vs.filter((x) => x !== s) : [...vs, s]));
    if (kind === "bool") return apply(build(isTruthy(v) ? "true" : "false"));
    if (!needsValue(op) || (op === "contains" && kind !== "set") || op === "starts") setOp("eq");
    setValue(s);
  };

  const dateKind: DateKind | null = ts ? "datetime" : isDate(kind) ? (kind as DateKind) : null;
  const withTz = /with time zone|timestamptz|timetz/i.test(column.typeName) || !!ts;

  const valueInput = (which: 1 | 2) => {
    const v = which === 1 ? value : value2;
    const set = which === 1 ? setValue : setValue2;
    return (
      <div className="relative flex h-8 min-w-0 flex-1 items-center rounded-md border border-line-strong bg-bg/40 focus-within:border-accent">
        <input
          ref={which === 1 ? firstInput : undefined}
          value={v}
          onChange={(e) => set(e.target.value)}
          placeholder={dateKind ? (dateKind === "date" ? "YYYY-MM-DD" : dateKind === "time" ? "HH:MM:SS" : "YYYY-MM-DD HH:MM:SS") : numeric ? "number" : "value"}
          spellCheck={false}
          className={cx("h-full min-w-0 flex-1 bg-transparent px-2 text-[12.5px] text-fg outline-none", numeric && "tabular-nums", badNum(v) && "text-err")}
        />
        {dateKind && (
          <button
            title="Pick a date"
            onClick={(e) => setPicker({ which, el: e.currentTarget.parentElement! })}
            className="mr-1 flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
          >
            <CalendarDays size={14} />
          </button>
        )}
      </div>
    );
  };

  const enumValues = column.enumValues ?? [];
  return createPortal(
    <div
      ref={panel}
      style={pos ?? { visibility: "hidden", left: 0, top: 0 }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
        else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          apply();
        }
      }}
      className="fixed z-[70] w-[380px] rounded-xl border border-line-strong bg-raised p-3 shadow-2xl shadow-black/50"
    >
      <div className="mb-2 flex items-baseline gap-2">
        <Filter size={13} className="shrink-0 self-center text-accent" />
        <span className="truncate text-[13px] font-semibold text-fg">{column.name}</span>
        <span className="truncate text-[11px] text-muted">{ts ? `Unix timestamp (${ts === "s" ? "seconds" : "ms"})` : column.typeName}</span>
      </div>

      <div className="flex flex-wrap gap-1">
        {ops.map((o) => (
          <button
            key={o}
            onClick={() => (needsValue(o) ? setOp(o) : apply(build(o)))}
            className={cx(
              "h-6 rounded-md px-2 text-[12px]",
              o === op ? "bg-accent text-white" : "border border-line-strong text-fg-2 hover:bg-hover hover:text-fg",
              !needsValue(o) && o !== op && "border-dashed",
            )}
            title={needsValue(o) ? undefined : "Apply now"}
          >
            {OP_LABEL[o]}
          </button>
        ))}
      </div>

      {dateKind && dateKind !== "time" && (
        <div className="mt-2 flex flex-wrap gap-1">
          {(Object.keys(RANGE_LABELS) as DateRange[]).map((r) => (
            <button
              key={r}
              onClick={() => apply(build("range", { range: r }))}
              className={cx("h-6 rounded-full px-2.5 text-[11.5px]", initial.op === "range" && initial.range === r ? "bg-accent-soft text-accent" : "bg-hover text-fg-2 hover:text-fg")}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
      )}

      {needsValue(op) && op !== "in" && (
        <div className="mt-2.5 flex items-center gap-1.5">
          {valueInput(1)}
          {op === "between" && (
            <>
              <span className="text-[12px] text-muted">and</span>
              {valueInput(2)}
            </>
          )}
        </div>
      )}

      {op === "in" && (
        <div className="mt-2.5 flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-line-strong bg-bg/40 p-1 focus-within:border-accent">
          {values.map((v) => (
            <span key={v} className="flex h-6 items-center gap-1 rounded bg-accent-soft pr-0.5 pl-2 text-[12px] text-fg">
              {v}
              <button onClick={() => setValues((vs) => vs.filter((x) => x !== v))} className="rounded p-0.5 text-muted hover:text-fg">
                <X size={11} />
              </button>
            </span>
          ))}
          <input
            ref={firstInput}
            value={listText}
            onChange={(e) => setListText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === ",") && listText.trim()) {
                e.preventDefault();
                e.stopPropagation();
                const add = listText.trim();
                setValues((vs) => (vs.includes(add) ? vs : [...vs, add]));
                setListText("");
              } else if (e.key === "Backspace" && !listText && values.length) setValues((vs) => vs.slice(0, -1));
            }}
            placeholder={values.length ? "" : "values, Enter after each"}
            spellCheck={false}
            className="h-6 min-w-[80px] flex-1 bg-transparent px-1 text-[12.5px] text-fg outline-none"
          />
        </div>
      )}

      {(kind === "enum" || kind === "set") && enumValues.length > 0 && needsValue(op) && op !== "contains" && (
        <div className="mt-2 flex max-h-[120px] flex-wrap gap-1 overflow-auto">
          {enumValues.map((v) => {
            const on = op === "in" ? values.includes(v) : value === v;
            return (
              <button
                key={v}
                onClick={() => (op === "in" ? setValues((vs) => (on ? vs.filter((x) => x !== v) : [...vs, v])) : setValue(v))}
                className={cx("h-6 rounded px-2 text-[12px]", on ? "bg-accent text-white" : "bg-accent-soft text-accent hover:bg-accent/25")}
              >
                {v}
              </button>
            );
          })}
        </div>
      )}

      {top !== null && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium text-muted">Most common values</div>
          {top === "loading" ? (
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <Spinner size={12} /> Counting…
            </div>
          ) : top === "error" ? (
            <div className="text-[12px] text-muted">Not available (too slow or not supported for this query).</div>
          ) : top.length === 0 ? (
            <div className="text-[12px] text-muted">No rows.</div>
          ) : (
            <div className="flex max-h-[132px] flex-wrap gap-1 overflow-auto">
              {top.map((t, i) => {
                const label = t.value === null ? "NULL" : ts ? fromEpoch(t.value, ts) : t.value === "" ? "(empty)" : t.value;
                const on = t.value !== null && (op === "in" ? values.includes(ts ? fromEpoch(t.value, ts) : t.value) : (ts ? fromEpoch(t.value, ts) : t.value) === value);
                return (
                  <button
                    key={i}
                    onClick={() => pickTop(t.value)}
                    onDoubleClick={() => t.value !== null && op !== "in" && op !== "between" && apply(build(needsValue(op) && op !== "starts" && op !== "contains" ? op : "eq"))}
                    title={`${t.n} rows · click to use, double-click to apply`}
                    className={cx(
                      "flex h-6 max-w-[170px] items-center gap-1.5 rounded px-2 text-[12px]",
                      on ? "bg-accent text-white" : "border border-line-strong text-fg-2 hover:border-accent hover:text-fg",
                      t.value === null && !on && "font-mono text-[10.5px] text-muted",
                    )}
                  >
                    <span className="truncate">{kind === "bool" && t.value !== null ? (isTruthy(t.value) ? "true" : "false") : label}</span>
                    <span className={cx("shrink-0 text-[10.5px] tabular-nums", on ? "text-white/75" : "text-muted")}>{Number(t.n).toLocaleString()}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-line pt-2.5">
        {onRemove && !isNew && (
          <button onClick={onRemove} className="rounded px-2 py-1 text-[12px] text-err hover:bg-err/10">
            Remove filter
          </button>
        )}
        <button onClick={onClose} className="ml-auto rounded px-2.5 py-1 text-[12px] text-fg-2 hover:bg-hover">
          Cancel
        </button>
        <button
          onClick={() => apply()}
          disabled={!result || !needsValue(op)}
          className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-40"
        >
          Apply
        </button>
      </div>

      {picker && dateKind && (
        <DateTimePicker
          kind={dateKind}
          withTz={withTz}
          applyUnchanged
          value={(picker.which === 1 ? value : value2) || null}
          anchor={picker.el}
          onApply={(v) => {
            (picker.which === 1 ? setValue : setValue2)(v ?? "");
            setPicker(null);
          }}
          onCancel={() => setPicker(null)}
        />
      )}
    </div>,
    document.body,
  );
}
