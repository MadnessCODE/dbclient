// Styled replacements for <select> and <input list>: the native popups ignore the app theme.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cx } from "./ui";
import { field } from "./ConnectionDialog";

export interface SelectOption {
  value: string;
  label?: string;
  /** Muted text on the right */
  hint?: string;
  /** Options with the same group are listed under its heading */
  group?: string;
}

type Row = { heading: string } | { opt: SelectOption; index: number };

function Panel({
  anchor,
  options,
  value,
  filter,
  hi,
  setHi,
  onPick,
  onClose,
  header,
}: {
  anchor: HTMLElement;
  options: SelectOption[];
  value: string;
  filter: string;
  hi: number;
  setHi: (i: number) => void;
  onPick: (v: string) => void;
  onClose: () => void;
  header?: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const rows = useMemo(() => {
    const out: Row[] = [];
    let group: string | undefined;
    options.forEach((opt, index) => {
      if (opt.group && opt.group !== group) out.push({ heading: opt.group });
      group = opt.group;
      out.push({ opt, index });
    });
    return out;
  }, [options]);

  useLayoutEffect(() => {
    if (!panel.current) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.current.getBoundingClientRect();
    const below = a.bottom + 4 + p.height <= window.innerHeight;
    setPos({
      left: Math.max(8, Math.min(a.left, window.innerWidth - p.width - 8)),
      top: below ? a.bottom + 4 : Math.max(8, a.top - p.height - 4),
      width: a.width,
    });
  }, [anchor, options.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [anchor, onClose]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  return createPortal(
    <div
      ref={panel}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, minWidth: pos?.width ?? 200 }}
      className="fixed z-[70] max-w-[420px] rounded-xl border border-line-strong bg-raised p-1.5 shadow-2xl shadow-black/50 outline-none"
    >
      {header}
      <div ref={listRef} className="max-h-[280px] overflow-y-auto">
        {options.length === 0 && <div className="px-2.5 py-2 text-[12px] text-muted">{filter ? "No match" : "No options"}</div>}
        {rows.map((r) =>
          "heading" in r ? (
            <div key={`h:${r.heading}`} className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {r.heading}
            </div>
          ) : (
            <button
              key={r.opt.value}
              type="button"
              data-i={r.index}
              onMouseEnter={() => setHi(r.index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(r.opt.value)}
              className={cx("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]", r.index === hi ? "bg-hover text-fg" : "text-fg-2")}
            >
              <span className="w-4 shrink-0 text-accent">{r.opt.value === value && <Check size={14} />}</span>
              <span className={cx("truncate", r.opt.value === value && "font-medium text-fg")}>{r.opt.label ?? r.opt.value}</span>
              {r.opt.hint && <span className="ml-auto shrink-0 pl-3 text-[12px] text-muted">{r.opt.hint}</span>}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}

const match = (o: SelectOption, q: string) => !q || `${o.label ?? ""} ${o.value}`.toLowerCase().includes(q.toLowerCase());

function useListKeys(count: number, pick: (i: number) => void, close: () => void) {
  const [hi, setHi] = useState(0);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi(Math.min(count - 1, hi + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi(Math.max(0, hi - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hi < count) pick(hi);
    } else if (e.key === "Escape") {
      // keep the dialog open
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  return { hi, setHi, onKey };
}

export function Select({ value, onChange, options, disabled, className }: { value: string; onChange: (v: string) => void; options: SelectOption[]; disabled?: boolean; className?: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => options.filter((o) => match(o, filter)), [options, filter]);
  const current = options.find((o) => o.value === value);
  const close = () => {
    setOpen(false);
    setFilter("");
    btn.current?.focus();
  };
  const pick = (v: string) => {
    onChange(v);
    close();
  };
  const keys = useListKeys(shown.length, (i) => pick(shown[i].value), close);
  const openList = () => {
    keys.setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            openList();
          } else if (open) keys.onKey(e);
        }}
        className={cx(field, "flex items-center gap-2 text-left", open && "border-accent", className)}
      >
        <span className="min-w-0 flex-1 truncate">{current ? (current.label ?? current.value) : value}</span>
        <ChevronDown size={15} className="shrink-0 text-muted" />
      </button>
      {open && btn.current && (
        <Panel
          anchor={btn.current}
          options={shown}
          value={value}
          filter={filter}
          hi={keys.hi}
          setHi={keys.setHi}
          onPick={pick}
          onClose={() => {
            setOpen(false);
            setFilter("");
          }}
          header={
            options.length > 10 && (
              <input
                autoFocus
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  keys.setHi(0);
                }}
                onKeyDown={keys.onKey}
                placeholder="Filter…"
                className="mb-1.5 h-8 w-full rounded-md border border-line-strong bg-bg/50 px-2.5 text-[13px] text-fg outline-none focus:border-accent"
              />
            )
          }
        />
      )}
    </>
  );
}

/** Free text with suggestions that filter as you type. */
export function Combo({ value, onChange, suggestions, placeholder }: { value: string; onChange: (v: string) => void; suggestions: string[]; placeholder?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const shown = useMemo(() => suggestions.filter((s) => s.toLowerCase().includes(value.toLowerCase())).slice(0, 200).map((s) => ({ value: s })), [suggestions, value]);
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  const keys = useListKeys(shown.length, (i) => pick(shown[i].value), () => setOpen(false));

  return (
    <>
      <input
        ref={input}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          onChange(e.target.value);
          keys.setHi(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (open && shown.length) keys.onKey(e);
          else if (e.key === "ArrowDown") setOpen(true);
        }}
        className={field}
      />
      {open && input.current && suggestions.length > 0 && (
        <Panel anchor={input.current} options={shown} value={value} filter={value} hi={keys.hi} setHi={keys.setHi} onPick={pick} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
