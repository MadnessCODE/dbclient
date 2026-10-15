// History tab: all runs from this tab, newest first.
import { useMemo, useState } from "react";
import { CircleAlert, CircleCheck, Copy, Play, RotateCcw, Star, Trash2 } from "lucide-react";
import { useStore, type EditorTab, type HistoryItem } from "../store";
import { timeAgo } from "./LeftPanel";
import { cx, IconButton, SearchInput } from "./ui";
import { openAddFavorite } from "./FavoritesView";

export function HistoryView({ tab }: { tab: EditorTab }) {
  const all = useStore((s) => s.history);
  const [filter, setFilter] = useState("");
  const items = useMemo(
    () => all.filter((h) => h.tabId === tab.id && (!filter || h.sql.toLowerCase().includes(filter.toLowerCase()))),
    [all, tab.id, filter],
  );
  const total = useMemo(() => all.filter((h) => h.tabId === tab.id).length, [all, tab.id]);

  if (total === 0) {
    return <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted">Queries you run in this tab will be listed here.</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 px-3.5">
        <SearchInput value={filter} onChange={setFilter} placeholder="Search this tab's history..." className="w-80" />
        <span className="text-[12px] text-muted">
          {items.length === total ? `${total} run${total > 1 ? "s" : ""}` : `${items.length} of ${total}`}
        </span>
        <button className="ml-auto text-[12px] text-accent hover:underline" onClick={() => useStore.getState().clearHistory(tab.id)}>
          Clear
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {items.length === 0 && <li className="px-2 py-3 text-[12px] text-muted">Nothing matches “{filter}”.</li>}
        {items.map((h) => (
          <HistoryRow key={h.id} item={h} tab={tab} />
        ))}
      </ul>
    </div>
  );
}

function HistoryRow({ item: h, tab }: { item: HistoryItem; tab: EditorTab }) {
  const st = useStore.getState;
  const [copied, setCopied] = useState(false);
  const isCurrent = h.sql.trim() === tab.sql.trim();

  return (
    <li
      onDoubleClick={() => st().updateTab(tab.id, { sql: h.sql })}
      title="Double-click to restore into the editor"
      className="group flex gap-3 rounded-md border-b border-line/60 px-2 py-2.5 hover:bg-hover"
    >
      {h.ok ? <CircleCheck size={16} className="mt-0.5 shrink-0 text-ok" /> : <CircleAlert size={16} className="mt-0.5 shrink-0 text-err" />}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-[11.5px] text-muted">
          <span title={new Date(h.at).toLocaleString()}>{new Date(h.at).toLocaleTimeString()}</span>
          <span>· {timeAgo(h.at)}</span>
          {h.ms !== undefined && <span>· {h.ms} ms</span>}
          {h.summary && (
            <span className={cx("truncate", h.ok ? "text-fg-2" : "text-err")} title={h.summary}>
              · {h.summary}
            </span>
          )}
          {isCurrent && <span className="rounded bg-accent-soft px-1.5 text-[10px] text-accent">current</span>}
        </div>
        <pre className="selectable line-clamp-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg-2">{h.sql}</pre>
      </div>
      <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <IconButton title="Restore into editor" onClick={() => st().updateTab(tab.id, { sql: h.sql })}>
          <RotateCcw size={14} />
        </IconButton>
        <IconButton title="Run again" onClick={() => void st().runTab(tab.id, h.sql)}>
          <Play size={14} />
        </IconButton>
        <IconButton
          title={copied ? "Copied!" : "Copy SQL"}
          onClick={() => {
            void navigator.clipboard.writeText(h.sql);
            setCopied(true);
            setTimeout(() => setCopied(false), 1000);
          }}
        >
          <Copy size={14} />
        </IconButton>
        <IconButton title="Add to favorites" onClick={() => openAddFavorite(h.sql, h.connId)}>
          <Star size={14} />
        </IconButton>
        <IconButton
          title="Remove from history"
          onClick={() => useStore.setState((s) => ({ history: s.history.filter((x) => x.id !== h.id) }))}
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
    </li>
  );
}
