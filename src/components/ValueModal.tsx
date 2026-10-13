// Single value viewer/editor (JSON tree, formatted or long text) and "Set value" for several cells.
import { useMemo, useState } from "react";
import { CalendarDays, ChevronDown, ChevronRight, Copy, Eraser, WandSparkles } from "lucide-react";
import type { Cell, DbKind, StructColumn } from "../lib/api";
import { isTruthy, type CellKind } from "../lib/cellKind";
import { CellEditor } from "./CellEditor";
import { DateTimePicker, type DateKind } from "./DateTimePicker";
import { Button, cx, Modal } from "./ui";

export function ValueModal({
  title,
  kind,
  value,
  editable,
  nullable,
  onSave,
  onClose,
}: {
  title: string;
  kind: CellKind;
  value: Cell;
  editable: boolean;
  nullable: boolean;
  onSave: (v: Cell) => void;
  onClose: () => void;
}) {
  const isJson = kind === "json";
  const pretty = (s: string) => {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      return s;
    }
  };
  const [text, setText] = useState(value === null ? "" : isJson ? pretty(value) : value);
  const [isNull, setIsNull] = useState(value === null);
  const [view, setView] = useState<"tree" | "text">(isJson && value !== null ? "tree" : "text");
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => {
    if (!isJson || isNull) return { ok: true as const, data: undefined };
    try {
      return { ok: true as const, data: JSON.parse(text) as unknown };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [isJson, isNull, text]);

  const save = () => {
    if (isNull) return onSave(null);
    if (isJson && parsed.ok) {
      // store JSON compact, as the database returns it
      try {
        return onSave(JSON.stringify(JSON.parse(text)));
      } catch {
        return;
      }
    }
    onSave(text);
  };

  return (
    <Modal title={`${title}${isJson ? " · JSON" : ""}`} onClose={onClose} width={760}>
      <div className="space-y-3 px-5 py-4">
        <div className="flex items-center gap-2">
          {isJson && !isNull && (
            <div className="flex rounded-md border border-line-strong p-0.5 text-[12px]">
              {(["tree", "text"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={cx("rounded px-3 py-1", view === v ? "bg-accent-soft text-fg" : "text-fg-2 hover:text-fg")}
                  disabled={v === "tree" && !parsed.ok}
                >
                  {v === "tree" ? "Tree" : "Text"}
                </button>
              ))}
            </div>
          )}
          {isJson && editable && !isNull && view === "text" && (
            <>
              <Button className="h-7" onClick={() => parsed.ok && setText(JSON.stringify(parsed.data, null, 2))} disabled={!parsed.ok}>
                <WandSparkles size={13} /> Format
              </Button>
              <Button className="h-7" onClick={() => parsed.ok && setText(JSON.stringify(parsed.data))} disabled={!parsed.ok}>
                Minify
              </Button>
            </>
          )}
          <div className="flex-1" />
          <Button
            className="h-7"
            onClick={() => {
              void navigator.clipboard.writeText(isNull ? "NULL" : text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1000);
            }}
          >
            <Copy size={13} /> {copied ? "Copied!" : "Copy"}
          </Button>
        </div>

        {isNull ? (
          <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-line-strong text-muted">
            <span className="rounded border border-dashed border-muted/60 bg-muted/10 px-2 py-0.5 font-mono text-[12px] font-semibold tracking-wider">NULL</span>
          </div>
        ) : view === "tree" && parsed.ok ? (
          <div className="selectable max-h-[55vh] overflow-auto rounded-md border border-line bg-bg/50 p-3 font-mono text-[12.5px] leading-relaxed">
            <JsonNode value={parsed.data} depth={0} />
          </div>
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            readOnly={!editable}
            spellCheck={false}
            rows={16}
            className={cx(
              "w-full resize-y rounded-md border bg-bg/50 p-3 font-mono text-[12.5px] leading-relaxed text-fg outline-none focus:border-accent",
              isJson && !parsed.ok ? "border-err" : "border-line",
            )}
          />
        )}
        {isJson && !parsed.ok && <p className="text-[12px] text-err">Invalid JSON: {parsed.error}</p>}
        {!isJson && !isNull && <p className="text-[11.5px] text-muted">{text.length.toLocaleString()} characters · {text.split("\n").length} lines</p>}

        <div className="flex items-center gap-2 border-t border-line pt-4">
          {editable && nullable && (
            <Button variant="ghost" onClick={() => setIsNull(!isNull)}>
              <Eraser size={14} /> {isNull ? "Not NULL" : "Set NULL"}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {editable ? "Cancel" : "Close"}
          </Button>
          {editable && (
            <Button variant="primary" onClick={save} disabled={isJson && !isNull && !parsed.ok}>
              Apply
            </Button>
          )}
        </div>
        {editable && <p className="text-right text-[11px] text-muted">Apply marks the change; it is written to the database when you click Save above the results.</p>}
      </div>
    </Modal>
  );
}

/** Collapsible JSON tree, colored by value type. */
function JsonNode({ value, depth, name }: { value: unknown; depth: number; name?: string }) {
  const [open, setOpen] = useState(depth < 2);
  const label = name !== undefined && <span className="text-[#6fd3ee]">{JSON.stringify(name)}: </span>;
  if (value === null) return <div>{label}<span className="text-muted">null</span></div>;
  if (typeof value === "string") return <div className="break-all">{label}<span className="text-[#f6a35b]">{JSON.stringify(value)}</span></div>;
  if (typeof value === "number") return <div>{label}<span className="text-[#7fd88f]">{value}</span></div>;
  if (typeof value === "boolean") return <div>{label}<span className="text-[#c792ea]">{String(value)}</span></div>;
  const isArr = Array.isArray(value);
  const entries = isArr ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const [o, c] = isArr ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return <div>{label}<span className="text-fg-2">{o}{c}</span></div>;
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-0.5 text-left hover:text-fg">
        {open ? <ChevronDown size={12} className="text-muted" /> : <ChevronRight size={12} className="text-muted" />}
        {label}
        <span className="text-fg-2">{o}</span>
        {!open && <span className="text-muted"> {entries.length} {isArr ? "items" : "keys"} {c}</span>}
      </button>
      {open && (
        <div className="ml-2 border-l border-line pl-3">
          {entries.map(([k, v]) => (
            <JsonNode key={k} name={isArr ? undefined : k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
      {open && <div className="text-fg-2">{c}</div>}
    </div>
  );
}

/** One value for several selected cells, with a type-specific editor. */
export function BulkSetDialog({
  count,
  kind,
  column,
  typeName,
  dbKind,
  onApply,
  onClose,
}: {
  count: number;
  kind: CellKind;
  column: StructColumn | null;
  typeName?: string;
  dbKind?: DbKind;
  onApply: (v: Cell) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState<Cell>(kind === "bool" ? "1" : "");
  const [editorKey, setEditorKey] = useState(0);
  const isDate = kind === "date" || kind === "datetime" || kind === "time";
  const [pickerOpen, setPickerOpen] = useState(isDate);
  // callback ref so the calendar opens as soon as the field mounts
  const [pickerAnchor, setPickerAnchor] = useState<HTMLButtonElement | null>(null);
  const withTz = /with time zone|timestamptz|timetz/.test(`${column?.columnType ?? ""} ${typeName ?? ""}`.toLowerCase());
  return (
    <Modal title={`Set value for ${count} cell${count === 1 ? "" : "s"}`} onClose={onClose} width={460}>
      <div className="space-y-4 px-5 py-4">
        {kind === "bool" ? (
          <div className="flex gap-2">
            {[
              ["1", "✓ true"],
              ["0", "✗ false"],
            ].map(([val, label]) => (
              <button
                key={val}
                onClick={() => setV(val)}
                className={cx("flex-1 rounded-md border px-3 py-2 text-[13px]", v !== null && isTruthy(v) === (val === "1") ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-hover")}
              >
                {label}
              </button>
            ))}
          </div>
        ) : kind === "enum" || kind === "set" ? (
          // values as buttons (ENUM: one, SET: several)
          <div className="flex flex-wrap gap-1.5">
            {(column?.enumValues ?? []).map((o) => {
              const picked = kind === "set" ? (v ?? "").split(",").includes(o) : v === o;
              return (
                <button
                  key={o}
                  onClick={() => {
                    if (kind === "enum") return setV(o);
                    const cur = (v ?? "").split(",").filter(Boolean);
                    const next = picked ? cur.filter((x) => x !== o) : [...cur, o];
                    setV((column?.enumValues ?? []).filter((x) => next.includes(x)).join(","));
                  }}
                  className={cx(
                    "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px]",
                    picked ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-fg-2 hover:bg-hover hover:text-fg",
                  )}
                >
                  {kind === "set" && <span className={cx("h-3.5 w-3.5 rounded border", picked ? "border-accent bg-accent" : "border-line-strong")} />}
                  {o}
                </button>
              );
            })}
          </div>
        ) : isDate ? (
          <>
            {/* date field; click opens the calendar */}
            <button
              ref={setPickerAnchor}
              onClick={() => setPickerOpen(true)}
              className="flex h-9 w-full items-center gap-2 rounded-md border border-line-strong bg-bg/40 px-3 text-left font-mono text-[13px] hover:border-accent"
            >
              <CalendarDays size={15} className="text-muted" />
              {v ? v : <span className="font-sans text-muted">Pick a {kind === "time" ? "time" : "date"}…</span>}
            </button>
            {pickerOpen && pickerAnchor && (
              <DateTimePicker
                kind={kind as DateKind}
                withTz={withTz}
                allowInfinity={dbKind === "postgres" && kind !== "time"}
                value={v || null}
                anchor={pickerAnchor}
                onApply={(x) => {
                  setV(x);
                  setPickerOpen(false);
                }}
                onCancel={() => setPickerOpen(false)}
              />
            )}
          </>
        ) : (
          <div className="relative h-9 rounded-md border border-line-strong">
            <CellEditor
              key={editorKey}
              kind={kind === "json" ? "text" : kind}
              value={v}
              column={column}
              onCommit={(x) => {
                setV(x);
                setEditorKey((k) => k + 1);
              }}
              onCancel={() => setEditorKey((k) => k + 1)}
            />
          </div>
        )}
        {!isDate && kind !== "bool" && kind !== "enum" && kind !== "set" && (
          <p className="text-[12px] text-muted">Current value: {v === null ? "NULL" : v === "" ? "(empty)" : v}. Press Enter in the field to confirm it.</p>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {column?.nullable && (
            <Button onClick={() => onApply(null)}>
              <Eraser size={14} /> Set NULL
            </Button>
          )}
          <Button variant="primary" onClick={() => onApply(v)} disabled={(isDate || kind === "enum") && !v}>
            Apply to {count}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
