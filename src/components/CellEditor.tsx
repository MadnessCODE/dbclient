// In-cell editors by column type: text/number, date/time picker, enum list, SET checkboxes.
import { useEffect, useRef, useState } from "react";
import type { Cell, DbKind, StructColumn } from "../lib/api";
import { formatEpoch, unixTsUnitOf, type CellKind, type TsUnit } from "../lib/cellKind";
import { DateTimePicker, parseDateValue, type DateKind } from "./DateTimePicker";
import { OptionPicker } from "./OptionPicker";
import { cx } from "./ui";

type Move = "down" | "right";

interface Props {
  kind: CellKind;
  value: Cell;
  /** Key that started editing (replaces the value) */
  initial?: string;
  column: StructColumn | null;
  /** Result type (e.g. "timestamptz") when the table structure is unknown */
  typeName?: string;
  /** Postgres allows -infinity / infinity dates */
  dbKind?: DbKind;
  /** Integer column holding Unix timestamps in this unit */
  unixTs?: TsUnit | null;
  onCommit: (v: Cell, move?: Move) => void;
  onCancel: () => void;
}

export function CellEditor(props: Props) {
  const { kind } = props;
  if (kind === "enum") return <EnumEditor {...props} />;
  if (kind === "set") return <SetEditor {...props} />;
  if (kind === "date" || kind === "datetime" || kind === "time") return <DateTimeEditor {...props} />;
  // typing a digit edits the raw number
  if (props.unixTs && props.initial === undefined && (props.value === null || /^\d+$/.test(props.value))) return <UnixTsEditor {...props} />;
  return <TextEditor {...props} />;
}

const box =
  "absolute inset-y-0 left-0 z-30 flex items-center gap-1 border border-accent bg-panel px-1 shadow-xl shadow-black/40 [min-width:100%]";
const input = "h-full min-w-0 flex-1 bg-transparent px-1.5 text-[13px] text-fg outline-none";

/** Enter = save and move down, Tab = save and move right, Esc = cancel. */
function keys(e: React.KeyboardEvent, commit: (move?: Move) => void, cancel: () => void) {
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    commit("down");
  } else if (e.key === "Tab") {
    e.preventDefault();
    commit("right");
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  }
}

function TextEditor({ kind, value, initial, onCommit, onCancel }: Props) {
  const [v, setV] = useState(initial ?? value ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (initial === undefined) ref.current?.select();
  }, [initial]);
  const invalid = kind === "number" && v.trim() !== "" && !/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v.trim());
  return (
    <div className={box} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => keys(e, (m) => !invalid && onCommit(v, m), onCancel)}
        onBlur={() => (invalid ? onCancel() : onCommit(v))}
        spellCheck={false}
        className={cx(input, kind === "number" && "text-right tabular-nums", invalid && "text-err")}
        title={invalid ? "Not a valid number" : "Enter to save · Esc to cancel"}
      />
    </div>
  );
}

/** Date/time input with a picker (keeps the zone for Postgres timestamptz/timetz). */
function DateTimeEditor({ kind, value, column, typeName, dbKind, onCommit, onCancel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => setAnchor(ref.current), []);
  const type = `${column?.columnType ?? ""} ${typeName ?? ""}`.toLowerCase();
  const withTz = /with time zone|timestamptz|timetz/.test(type);
  return (
    <div ref={ref} className={box} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="truncate px-1.5 font-mono text-[12.5px] text-fg">{value ?? "NULL"}</span>
      {anchor && (
        <DateTimePicker
          kind={kind as DateKind}
          withTz={withTz}
          value={value}
          allowInfinity={dbKind === "postgres" && kind !== "time"}
          anchor={anchor}
          onApply={(v) => onCommit(v)}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

/** Local "+02:00" offset for an instant. */
function offsetAt(ms: number) {
  const min = -new Date(ms).getTimezoneOffset();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${min >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(min) / 60))}:${p(Math.abs(min) % 60)}`;
}

/** Integer Unix timestamp edited with the datetime picker (local time, zone selectable). */
function UnixTsEditor({ value, unixTs, onCommit, onCancel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => setAnchor(ref.current), []);
  const unit: TsUnit = (value && unixTsUnitOf(value)) || unixTs || "s";
  const ms = value ? Number(value) * (unit === "s" ? 1000 : 1) : null;
  const shown = ms === null ? null : `${formatEpoch(ms)}${offsetAt(ms)}`;
  const toEpoch = (v: string | null): Cell | undefined => {
    if (v === null) return null;
    if (/^\d+$/.test(v.trim())) return v.trim();
    const p = parseDateValue("datetime", v);
    if (!p) return undefined;
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(p.tz ?? "");
    const offMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null;
    const frac = Number(`0.${p.frac || "0"}`) * 1000;
    const wall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) + Math.round(frac);
    // without a zone the value is local time
    const t = offMin === null ? new Date(p.y, p.m - 1, p.d, p.h, p.mi, p.s, Math.round(frac)).getTime() : wall - offMin * 60_000;
    return String(unit === "s" ? Math.floor(t / 1000) : t);
  };
  return (
    <div ref={ref} className={box} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="truncate px-1.5 font-mono text-[12.5px] text-fg">{value ?? "NULL"}</span>
      {anchor && (
        <DateTimePicker
          kind="datetime"
          withTz
          value={shown}
          anchor={anchor}
          onApply={(v) => {
            const next = toEpoch(v);
            if (next === undefined || next === value) onCancel();
            else onCommit(next);
          }}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

function EnumEditor({ value, column, onCommit, onCancel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => setAnchor(ref.current), []);
  return (
    <div ref={ref} className={box} onMouseDown={(e) => e.stopPropagation()}>
      <span className="truncate px-1.5 text-[13px] text-fg">{value ?? "NULL"}</span>
      {anchor && (
        <OptionPicker
          options={column?.enumValues ?? []}
          value={value}
          nullable={!!column?.nullable}
          anchor={anchor}
          onPick={(v) => (v === value ? onCancel() : onCommit(v))}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

/** MySQL SET: several values, e.g. "red,blue". */
function SetEditor({ value, column, onCommit, onCancel }: Props) {
  const [picked, setPicked] = useState<string[]>(value ? value.split(",").filter(Boolean) : []);
  const ref = useRef<HTMLDivElement>(null);
  const values = column?.enumValues ?? [];
  const done = () => onCommit(values.filter((v) => picked.includes(v)).join(","));
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => keys(e, done, onCancel)}
      onBlur={(e) => !ref.current?.contains(e.relatedTarget as Node) && done()}
      className="absolute top-0 left-0 z-30 min-w-[200px] rounded-md border border-accent bg-panel p-1.5 shadow-xl shadow-black/40 outline-none"
    >
      {values.map((v) => (
        <label key={v} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] hover:bg-hover">
          <input
            type="checkbox"
            className="accent-[var(--accent)]"
            checked={picked.includes(v)}
            onChange={(e) => setPicked((p) => (e.target.checked ? [...p, v] : p.filter((x) => x !== v)))}
          />
          {v}
        </label>
      ))}
      <div className="mt-1 flex justify-end gap-1 border-t border-line pt-1.5">
        <button onClick={onCancel} className="rounded px-2 py-1 text-[12px] text-muted hover:bg-hover">
          Cancel
        </button>
        <button onClick={done} className="rounded bg-accent px-2 py-1 text-[12px] text-white">
          OK
        </button>
      </div>
    </div>
  );
}
