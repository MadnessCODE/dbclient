// Small shared UI components.
import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Database } from "lucide-react";
import type { DbKind } from "../lib/api";
import { DB_LOGOS, PG_FULL } from "../lib/dbLogos";
import { connColor, connEnv } from "../lib/connStyle";
import type { ConnectionConfig } from "../lib/api";
import type { ConnStatus } from "../store";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex h-8 items-center justify-center gap-2 rounded-md px-3 text-[13px] font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-accent text-white hover:bg-accent-hover",
        variant === "secondary" && "border border-line-strong bg-panel-2 text-fg-2 hover:bg-hover hover:text-fg",
        variant === "ghost" && "text-fg-2 hover:bg-hover hover:text-fg",
        variant === "danger" && "bg-err/90 text-white hover:bg-err",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({
  title,
  className,
  children,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { title: string; active?: boolean }) {
  return (
    <button
      {...rest}
      title={title}
      aria-label={title}
      className={cx(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors",
        "hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent",
        active && "bg-accent-soft text-accent",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** PostgreSQL elephant / MySQL dolphin. */
export function DbIcon({ kind, size = 18, className }: { kind: DbKind; size?: number; className?: string }) {
  if (kind === "postgres") {
    // white outline, body in the theme color (--pg), white strokes
    return (
      <svg width={size} height={size} viewBox={PG_FULL.viewBox} role="img" aria-label="PostgreSQL" className={cx("shrink-0 text-pg", className)}>
        {PG_FULL.outline.map((d, i) => (
          <path key={i} d={d} fill="#fff" />
        ))}
        <path d={PG_FULL.body} fill="currentColor" />
        <path d={PG_FULL.details} fill="#fff" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox={DB_LOGOS[kind].viewBox}
      fill="currentColor"
      role="img"
      aria-label="MySQL"
      className={cx("shrink-0 text-my", className)}
    >
      <path d={DB_LOGOS[kind].path} />
    </svg>
  );
}

/** Schema/database icon (plain cylinder). */
export function SchemaIcon({ size = 16, className }: { size?: number; className?: string }) {
  return <Database size={size} className={cx("shrink-0 text-muted", className)} />;
}

export function StatusDot({ status, className }: { status: ConnStatus | undefined; className?: string }) {
  return (
    <span
      className={cx(
        "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
        status === "connected" && "bg-ok shadow-[0_0_0_3px_rgba(34,197,94,0.18)]",
        status === "connecting" && "animate-pulse bg-warn",
        status === "error" && "bg-err",
        (!status || status === "idle") && "bg-muted/60",
        className,
      )}
    />
  );
}

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-line bg-panel-2", className)}>
      {title && (
        <header className="flex items-center justify-between px-3.5 pt-3 pb-2">
          <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <label className={cx("flex h-8 items-center gap-2 rounded-md border border-line-strong bg-bg/40 px-2.5 focus-within:border-accent", className)}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-muted">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-muted"
      />
    </label>
  );
}

export function Modal({ title, onClose, children, width = 480 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        className="max-h-[90vh] overflow-auto rounded-xl border border-line-strong bg-panel shadow-2xl"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <IconButton title="Close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}

/** Draggable splitter; the size is kept in localStorage. */
export function useResizable(key: string, initial: number, min: number, max: number, direction: "x" | "y", invert = false) {
  const [size, setSize] = useState(() => {
    const saved = Number(localStorage.getItem(`size:${key}`));
    return saved >= min && saved <= max ? saved : initial;
  });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const start = direction === "x" ? e.clientX : e.clientY;
      const startSize = sizeRef.current;
      const move = (ev: MouseEvent) => {
        const delta = (direction === "x" ? ev.clientX : ev.clientY) - start;
        setSize(Math.min(max, Math.max(min, startSize + (invert ? -delta : delta))));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.style.cursor = "";
        localStorage.setItem(`size:${key}`, String(sizeRef.current));
      };
      document.body.style.cursor = direction === "x" ? "col-resize" : "row-resize";
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [direction, invert, key, max, min],
  );
  return { size, onMouseDown };
}

export function Splitter({ direction, onMouseDown }: { direction: "x" | "y"; onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className={cx(
        "group relative z-10 shrink-0",
        direction === "x" ? "w-1 cursor-col-resize" : "h-1.5 cursor-row-resize",
      )}
    >
      <div
        className={cx(
          "absolute bg-transparent transition-colors group-hover:bg-accent/50",
          direction === "x" ? "inset-y-0 left-0 w-0.5" : "inset-x-0 top-0.5 h-0.5",
        )}
      />
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Environment badge (PROD / STAGING / DEV) in the connection color. */
export function EnvBadge({ cfg, className }: { cfg: Pick<ConnectionConfig, "environment" | "color"> | undefined | null; className?: string }) {
  const env = connEnv(cfg);
  if (!env) return null;
  const color = connColor(cfg) ?? (env.key === "production" ? "#ef4444" : "#7a89a6");
  return (
    <span
      style={{ color, background: `${color}26`, borderColor: `${color}66` }}
      className={cx("shrink-0 rounded border px-1 py-px text-[9.5px] leading-none font-bold tracking-wide", className)}
    >
      {env.short}
    </span>
  );
}
