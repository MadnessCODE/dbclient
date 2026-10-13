import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, History, Moon, Play, Settings, Sheet, Sun } from "lucide-react";
import { kindLabel } from "../lib/api";
import { quoteIdent } from "../lib/sql";
import { useStore } from "../store";
import { cx, DbIcon, Modal } from "./ui";
import { field } from "./ConnectionDialog";

export { ConnectionDialog, PasswordDialog } from "./ConnectionDialog";


interface PaletteItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  detail?: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette />;
}

function Palette() {
  const st = useStore();
  const close = () => st.setUi({ paletteOpen: false });
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const all = useMemo(() => {
    const items: PaletteItem[] = [];
    for (const c of st.connections) {
      const schema = st.conn[c.id]?.schema;
      for (const s of schema?.schemas ?? []) {
        if (s.system) continue;
        for (const t of [...s.tables, ...s.views, ...s.matViews]) {
          const isView = !s.tables.includes(t);
          items.push({
            key: `t:${c.id}:${s.name}.${t}`,
            icon: isView ? <Eye size={15} className="text-muted" /> : <Sheet size={15} className="text-muted" />,
            label: `${s.name}.${t}`,
            detail: c.name,
            run: () => st.newTab({ sql: `SELECT *\nFROM ${quoteIdent(s.name, c.kind)}.${quoteIdent(t, c.kind)}\nLIMIT 100;`, connId: c.id, title: `${t}.sql`, run: true, table: { schema: s.name, table: t } }),
          });
        }
        for (const col of schema!.columns.filter((x) => x.schema === s.name)) {
          if (!q) continue; // columns only while typing
          items.push({
            key: `c:${c.id}:${s.name}.${col.table}.${col.name}`,
            icon: <span className="w-[15px] text-center text-[11px] text-muted">#</span>,
            label: `${col.table}.${col.name}`,
            detail: `${col.dataType} · ${c.name}`,
            run: () =>
              st.newTab({
                sql: `SELECT ${quoteIdent(col.name, c.kind)}, count(*)\nFROM ${quoteIdent(s.name, c.kind)}.${quoteIdent(col.table, c.kind)}\nGROUP BY 1\nORDER BY 2 DESC\nLIMIT 100;`,
                connId: c.id,
                title: `${col.table}.sql`,
                run: true,
              }),
          });
        }
      }
      items.push({
        key: `conn:${c.id}`,
        icon: <DbIcon kind={c.kind} size={15} />,
        label: `Connect: ${c.name}`,
        detail: `${kindLabel(c.kind)} · ${c.host}:${c.port}`,
        run: () => {
          st.selectConnection(c.id);
          void st.connectTo(c.id);
        },
      });
    }
    items.push(
      { key: "a:new", icon: <Play size={15} className="text-muted" />, label: "New query", detail: "Ctrl+T", run: () => st.newTab() },
      { key: "a:theme", icon: st.theme === "dark" ? <Sun size={15} className="text-muted" /> : <Moon size={15} className="text-muted" />, label: "Toggle theme", run: st.toggleTheme },
      { key: "a:settings", icon: <Settings size={15} className="text-muted" />, label: "Settings", run: () => st.setUi({ settingsOpen: true }) },
    );
    for (const h of st.history.slice(0, 30)) {
      items.push({
        key: `h:${h.id}`,
        icon: <History size={15} className="text-muted" />,
        label: h.sql.replace(/\s+/g, " ").slice(0, 90),
        detail: "history",
        run: () => st.newTab({ sql: h.sql, connId: h.connId, title: h.title }),
      });
    }
    return items;
  }, [st, q]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all.slice(0, 50);
    return all.filter((i) => i.label.toLowerCase().includes(needle) || i.detail?.toLowerCase().includes(needle)).slice(0, 50);
  }, [all, q]);

  useEffect(() => {
    setIdx(0);
  }, [q]);
  useEffect(() => {
    listRef.current?.children[idx]?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const choose = (item?: PaletteItem) => {
    if (!item) return;
    close();
    item.run();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-[12vh]" onMouseDown={close}>
      <div className="h-fit w-[620px] overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setIdx((i) => Math.min(i + 1, filtered.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setIdx((i) => Math.max(i - 1, 0)));
            else if (e.key === "Enter") choose(filtered[idx]);
            else if (e.key === "Escape") close();
          }}
          placeholder="Search tables, columns, connections, history…"
          className="h-12 w-full border-b border-line bg-transparent px-4 text-[14px] text-fg outline-none placeholder:text-muted"
        />
        <ul ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && <li className="px-3 py-3 text-[13px] text-muted">No matches. Connect to a database to search its tables.</li>}
          {filtered.map((item, i) => (
            <li
              key={item.key}
              onMouseEnter={() => setIdx(i)}
              onClick={() => choose(item)}
              className={cx("flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[13px]", i === idx && "bg-accent-soft")}
            >
              {item.icon}
              <span className="flex-1 truncate">{item.label}</span>
              {item.detail && <span className="shrink-0 text-[11px] text-muted">{item.detail}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}


export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  const theme = useStore((s) => s.theme);
  const { setSettings, toggleTheme, setUi } = useStore.getState();
  if (!open) return null;
  return (
    <Modal title="Settings" onClose={() => setUi({ settingsOpen: false })} width={440}>
      <div className="space-y-4 px-5 py-4 text-[13px]">
        <Row label="Theme">
          <select className={field} value={theme} onChange={(e) => e.target.value !== theme && toggleTheme()}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </Row>
        <Row label="Max rows per query" hint="Rows beyond this are not loaded.">
          <select className={field} value={settings.maxRows} onChange={(e) => setSettings({ maxRows: Number(e.target.value) })}>
            {[1000, 5000, 10000, 50000, 100000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Editor font size">
          <select className={field} value={settings.fontSize} onChange={(e) => setSettings({ fontSize: Number(e.target.value) })}>
            {[12, 13, 14, 15, 16, 18].map((n) => (
              <option key={n} value={n}>
                {n}px
              </option>
            ))}
          </select>
        </Row>
        <div className="rounded-md bg-hover/60 p-3 text-[12px] leading-relaxed text-fg-2">
          <button className="mb-2 block text-accent hover:underline" onClick={() => setUi({ settingsOpen: false, aboutOpen: true })}>
            About DB Client · by MadnessCODE
          </button>
          <b>Shortcuts:</b> Ctrl+Enter run statement · Ctrl+Shift+Enter / F5 run all · Ctrl+E explain · Shift+Alt+F format · Ctrl+S save · Ctrl+K search · Ctrl+T new tab · Ctrl+W close tab
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[170px_1fr] items-center gap-3">
      <div>
        <div className="text-fg">{label}</div>
        {hint && <div className="text-[11px] text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
