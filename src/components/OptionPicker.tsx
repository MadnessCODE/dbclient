// Single value picker (ENUM), styled instead of a native <select>.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { cx } from "./ui";

export function OptionPicker({
  options,
  value,
  nullable,
  anchor,
  onPick,
  onCancel,
}: {
  options: string[];
  value: string | null;
  nullable: boolean;
  anchor: HTMLElement | null;
  /** null = NULL */
  onPick: (v: string | null) => void;
  onCancel: () => void;
}) {
  const [filter, setFilter] = useState("");
  const items = useMemo(() => {
    const list: (string | null)[] = options.filter((o) => o.toLowerCase().includes(filter.toLowerCase()));
    return nullable && !filter ? [null, ...list] : list;
  }, [options, filter, nullable]);
  const [hi, setHi] = useState(() => Math.max(0, items.indexOf(value)));
  const panel = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !panel.current) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.current.getBoundingClientRect();
    const below = a.bottom + 4 + p.height <= window.innerHeight;
    setPos({
      left: Math.max(8, Math.min(a.left, window.innerWidth - p.width - 8)),
      top: below ? a.bottom + 4 : Math.max(8, a.top - p.height - 4),
      width: Math.max(a.width, 200),
    });
  }, [anchor, items.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onCancel();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [anchor, onCancel]);

  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(items.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[hi] !== undefined) onPick(items[hi]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return createPortal(
    <div
      ref={panel}
      tabIndex={-1}
      onKeyDown={onKey}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, minWidth: pos?.width ?? 200 }}
      className="fixed z-[70] max-w-[360px] rounded-xl border border-line-strong bg-raised p-1.5 shadow-2xl shadow-black/50 outline-none"
    >
      {options.length > 8 ? (
        <input
          autoFocus
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setHi(0);
          }}
          placeholder="Filter…"
          className="mb-1.5 h-8 w-full rounded-md border border-line-strong bg-bg/50 px-2.5 text-[13px] text-fg outline-none focus:border-accent"
        />
      ) : (
        <FocusOnMount target={panel} />
      )}
      <div ref={listRef} className="max-h-[260px] overflow-y-auto">
        {items.length === 0 && <div className="px-2.5 py-2 text-[12px] text-muted">No match</div>}
        {items.map((o, i) => {
          const selected = o === value;
          return (
            <button
              key={o ?? "\u0000null"}
              onMouseEnter={() => setHi(i)}
              onClick={() => onPick(o)}
              className={cx(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]",
                i === hi ? "bg-hover text-fg" : "text-fg-2",
                o === null && nullable && "mb-1",
              )}
            >
              <span className="w-4 shrink-0 text-accent">{selected && <Check size={14} />}</span>
              {o === null ? (
                <span className="rounded border border-dashed border-muted/60 bg-muted/10 px-1.5 py-px font-mono text-[10.5px] font-semibold tracking-wider text-muted">NULL</span>
              ) : (
                <span className={cx("truncate", selected && "font-medium text-fg")}>{o}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

function FocusOnMount({ target }: { target: React.RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    target.current?.focus();
  }, [target]);
  return null;
}
