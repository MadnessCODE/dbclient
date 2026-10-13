// App-wide context menu and the SQL action dialog (drop, rename, truncate...).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { api, errorText } from "../lib/api";
import { useStore, type MenuEntry } from "../store";
import { isProduction } from "../lib/connStyle";
import { Button, cx, Modal, Spinner } from "./ui";

export function ContextMenuHost() {
  const menu = useStore((s) => s.contextMenu);
  const close = () => useStore.getState().setUi({ contextMenu: null });

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-context-menu]")) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  if (!menu) return null;
  return <MenuPanel items={menu.items} x={menu.x} y={menu.y} onDone={close} />;
}

function MenuPanel({ items, x, y, onDone }: { items: MenuEntry[]; x: number; y: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [openSub, setOpenSub] = useState<number | null>(null);

  // keep inside the window
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y]);

  return (
    <div
      ref={ref}
      data-context-menu
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[60] min-w-[220px] rounded-lg border border-line-strong bg-raised p-1 shadow-2xl"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === "sep" ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <div key={i} className="relative" onMouseEnter={() => setOpenSub(item.children ? i : null)}>
            <button
              disabled={item.disabled}
              title={item.hint}
              onClick={() => {
                if (item.children) return setOpenSub(i);
                onDone();
                item.onClick?.();
              }}
              className={cx(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] disabled:opacity-40",
                item.danger ? "text-err hover:bg-err/10" : "text-fg hover:bg-hover",
                openSub === i && "bg-hover",
              )}
            >
              <span className="flex w-4 justify-center text-muted [&>svg]:h-[15px] [&>svg]:w-[15px]">{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.children && <ChevronRight size={14} className="text-muted" />}
            </button>
            {item.children && openSub === i && (
              <div className="absolute top-0 left-full pl-1">
                <SubMenu items={item.children} onDone={onDone} />
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}

function SubMenu({ items, onDone }: { items: MenuEntry[]; onDone: () => void }) {
  return (
    <div data-context-menu className="min-w-[200px] rounded-lg border border-line-strong bg-raised p-1 shadow-2xl">
      {items.map((item, i) =>
        item === "sep" ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => {
              onDone();
              item.onClick?.();
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg hover:bg-hover disabled:opacity-40"
          >
            <span className="flex w-4 justify-center text-muted [&>svg]:h-[15px] [&>svg]:w-[15px]">{item.icon}</span>
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}


export function ActionDialogHost() {
  const dlg = useStore((s) => s.actionDialog);
  if (!dlg) return null;
  return <ActionDialogView key={dlg.title + dlg.connId} />;
}

function ActionDialogView() {
  const dlg = useStore((s) => s.actionDialog)!;
  const close = () => useStore.getState().setUi({ actionDialog: null });
  const [input, setInput] = useState(dlg.input?.value ?? "");
  const [sql, setSql] = useState(() => dlg.buildSql(dlg.input?.value ?? ""));
  const [sqlEdited, setSqlEdited] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeInput = (v: string) => {
    setInput(v);
    if (!sqlEdited) setSql(dlg.buildSql(v));
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await api.runQuery(dlg.connId, crypto.randomUUID(), sql, 10);
      close();
      dlg.afterRun?.();
      void useStore.getState().refreshSchema(dlg.connId);
    } catch (e) {
      setError(errorText(e));
      setRunning(false);
    }
  };

  return (
    <Modal title={dlg.title} onClose={close} width={560}>
      <form
        className="space-y-4 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
{isProduction(useStore.getState().connections.find((c) => c.id === dlg.connId)) && (
          <p className="flex items-center gap-2 rounded-md bg-err/15 px-3 py-2 text-[13px] font-medium text-err">
            <TriangleAlert size={15} /> This runs on a PRODUCTION database.
          </p>
        )}
        {dlg.message && (
          <p className={cx("flex items-start gap-2 text-[13px]", dlg.danger ? "text-err" : "text-fg-2")}>
            {dlg.danger && <TriangleAlert size={16} className="mt-0.5 shrink-0" />}
            {dlg.message}
          </p>
        )}
        {dlg.input && (
          <label className="block space-y-1.5">
            <span className="text-[12px] text-muted">{dlg.input.label}</span>
            <input
              autoFocus
              value={input}
              onChange={(e) => changeInput(e.target.value)}
              spellCheck={false}
              className="h-9 w-full rounded-md border border-line-strong bg-bg/40 px-3 text-[13px] outline-none focus:border-accent"
            />
          </label>
        )}
        <label className="block space-y-1.5">
          <span className="text-[12px] text-muted">SQL (you can edit it)</span>
          <textarea
            value={sql}
            onChange={(e) => {
              setSql(e.target.value);
              setSqlEdited(true);
            }}
            rows={Math.min(10, sql.split("\n").length + 1)}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-line-strong bg-bg/50 p-3 font-mono text-[12.5px] text-fg outline-none focus:border-accent"
          />
        </label>
        {error && <p className="selectable rounded-md bg-err/10 px-3 py-2 text-[13px] text-err">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant={dlg.danger ? "danger" : "primary"} disabled={running || !sql.trim() || (!!dlg.input && !input.trim()) || (dlg.requireInput !== undefined && input !== dlg.requireInput)}>
            {running && <Spinner />} {dlg.confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
