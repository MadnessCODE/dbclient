// Favorites picker of the query editor (saved queries grouped by category) and the add/edit favorite dialog.
import { useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Folder,
  FolderInput,
  FolderPlus,
  Pencil,
  Play,
  Replace,
  SquarePlus,
  Star,
  TextCursorInput,
  Trash2,
} from "lucide-react";
import { useStore, type EditorTab, type FavoriteQuery, type MenuEntry } from "../store";
import { insertIntoEditor } from "../lib/editorBridge";
import { baseId } from "../lib/connIds";
import { Button, cx, IconButton, Modal, SearchInput } from "./ui";
import { field } from "./ConnectionDialog";

const UNCATEGORIZED = "__none__";

/** Opens the add-favorite dialog for `sql`. */
export function openAddFavorite(sql: string, connId?: string | null) {
  if (!sql.trim()) return;
  useStore.getState().setUi({ favoriteDialog: { favorite: { sql: sql.trim(), name: defaultName(sql), connId: connId ?? null } } });
}

/** A leading "-- comment", otherwise the SQL on one line, e.g. "SELECT * FROM users WHERE ...". */
function defaultName(sql: string): string {
  const comment = /^\s*--\s*(.+)/.exec(sql)?.[1].trim();
  const text = comment || sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 60).trimEnd()}…` : text;
}

const st = useStore.getState;

function replaceEditor(tab: EditorTab, f: FavoriteQuery) {
  st().updateTab(tab.id, { sql: f.sql });
}

function insertFavorite(tab: EditorTab, f: FavoriteQuery) {
  if (!insertIntoEditor(tab.id, f.sql)) replaceEditor(tab, f);
}

function openInNewTab(tab: EditorTab, f: FavoriteQuery) {
  st().newTab({ sql: f.sql, title: f.name, connId: tab.connId, database: tab.database });
}

async function deleteFavorite(f: FavoriteQuery) {
  const ok = await ask(`Delete the favorite "${f.name}"?`, { title: "Delete favorite", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" });
  if (ok) st().removeFavorite(f.id);
}

/** `done` closes the picker after actions that leave it. */
function favoriteMenu(tab: EditorTab, f: FavoriteQuery, done: () => void): MenuEntry[] {
  const cats = st().favoriteCategories;
  const then = (fn: () => void) => () => {
    fn();
    done();
  };
  return [
    { label: "Insert at cursor", icon: <TextCursorInput />, shortcut: "Enter", onClick: then(() => insertFavorite(tab, f)) },
    { label: "Replace editor content", icon: <Replace />, onClick: then(() => replaceEditor(tab, f)) },
    { label: "Open in new tab", icon: <SquarePlus />, shortcut: "Shift+Enter", onClick: then(() => openInNewTab(tab, f)) },
    { label: "Run", icon: <Play />, onClick: then(() => void st().runTab(tab.id, f.sql)) },
    { label: "Copy SQL", icon: <ClipboardCopy />, onClick: () => void navigator.clipboard.writeText(f.sql) },
    "sep",
    { label: "Edit…", icon: <Pencil />, onClick: () => st().setUi({ favoriteDialog: { favorite: f } }) },
    {
      label: "Move to",
      icon: <FolderInput />,
      children: [
        { label: "Uncategorized", disabled: f.categoryId === null, onClick: () => st().moveFavorite(f.id, null) },
        ...cats.map((c) => ({ label: c.name, icon: <Folder />, disabled: f.categoryId === c.id, onClick: () => st().moveFavorite(f.id, c.id) }) as MenuEntry),
      ],
    },
    "sep",
    { label: "Delete", icon: <Trash2 />, danger: true, onClick: () => void deleteFavorite(f) },
  ];
}

/** Favorites dropdown of the query editor: search, categories, insert / open / run. */
export function FavoritesPicker({ tab, onAdd, onClose }: { tab: EditorTab; onAdd: () => void; onClose: () => void }) {
  const favorites = useStore((s) => s.favorites);
  const categories = useStore((s) => s.favoriteCategories);
  const [filter, setFilter] = useState("");
  // categories start collapsed; a search opens the ones with matches
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => searchRef.current?.focus(), []);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const match = (f: FavoriteQuery) => !needle || f.name.toLowerCase().includes(needle) || f.sql.toLowerCase().includes(needle);
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    const out = [...categories].sort(byName).map((c) => ({ id: c.id, name: c.name, items: favorites.filter((f) => f.categoryId === c.id && match(f)).sort(byName) }));
    const known = new Set(categories.map((c) => c.id));
    const loose = favorites.filter((f) => (f.categoryId === null || !known.has(f.categoryId)) && match(f)).sort(byName);
    out.push({ id: UNCATEGORIZED, name: "Uncategorized", items: loose });
    // while searching, only groups with matches; otherwise empty categories stay visible
    return out.filter((g) => (needle ? g.items.length > 0 : g.id !== UNCATEGORIZED || g.items.length > 0));
  }, [favorites, categories, filter]);

  // favorites in display order, for keyboard navigation
  const visible = useMemo(() => groups.flatMap((g) => (expanded.has(g.id) || filter ? g.items : [])), [groups, expanded, filter]);
  const shown = groups.reduce((n, g) => n + g.items.length, 0);

  useEffect(() => setActive(0), [filter]);
  useEffect(() => {
    listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== searchRef.current) return;
    const f = visible[active];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && f) {
      e.preventDefault();
      if (e.shiftKey) openInNewTab(tab, f);
      else insertFavorite(tab, f);
      onClose();
    }
  };

  return (
    <div className="flex max-h-[min(560px,70vh)] flex-col" onKeyDown={onKeyDown}>
      <div className="space-y-2 border-b border-line p-2.5">
        <SearchInput inputRef={searchRef} value={filter} onChange={setFilter} placeholder="Search favorites by name or SQL..." className="w-full" />
        <div className="flex items-center gap-1">
          <span className="flex-1 pl-0.5 text-[11.5px] text-muted">
            {shown === favorites.length ? `${favorites.length} favorite${favorites.length === 1 ? "" : "s"}` : `${shown} of ${favorites.length}`}
          </span>
          <Button variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => setCreating(true)}>
            <FolderPlus size={14} /> New category
          </Button>
          <Button variant="ghost" className="h-7 px-2 text-[12px]" disabled={!tab.sql.trim()} onClick={onAdd} title="Selection, the statement under the cursor, or everything">
            <Star size={14} /> Add current
          </Button>
        </div>
      </div>
      <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {favorites.length === 0 && !creating && (
          <li className="px-3 py-6 text-center text-[12.5px] leading-relaxed text-muted">
            No favorites yet. Right-click in the editor and choose “Add to favorites”, or use “Add current”.
          </li>
        )}
        {creating && (
          <li className="flex items-center gap-2 px-2 py-1.5">
            <Folder size={15} className="text-muted" />
            <NameInput
              initial=""
              placeholder="Category name"
              onDone={(name) => {
                if (name) st().addFavoriteCategory(name);
                setCreating(false);
              }}
            />
          </li>
        )}
        {shown === 0 && filter && <li className="px-2 py-3 text-[12px] text-muted">Nothing matches “{filter}”.</li>}
        {groups.map((g) => {
          const open = expanded.has(g.id) || !!filter;
          const isCat = g.id !== UNCATEGORIZED;
          const remove = () => void deleteCategory(g.id, g.name, favorites.filter((f) => f.categoryId === g.id).length);
          const menu: MenuEntry[] = [
            { label: "Rename…", icon: <Pencil />, onClick: () => setRenaming(g.id) },
            { label: "Delete category", icon: <Trash2 />, danger: true, onClick: remove },
          ];
          return (
            <li key={g.id}>
              <div
                onClick={() => renaming !== g.id && toggle(g.id)}
                onContextMenu={(e) => isCat && st().openContextMenu(e, menu)}
                className="group flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[12.5px] font-medium text-fg-2 hover:bg-hover"
              >
                {open ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
                <Folder size={15} className="text-muted" />
                {renaming === g.id ? (
                  <NameInput
                    initial={g.name}
                    placeholder="Category name"
                    onDone={(name) => {
                      if (name) st().renameFavoriteCategory(g.id, name);
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="truncate">{g.name}</span>
                )}
                <span className="text-[11px] font-normal text-muted">{g.items.length}</span>
                {isCat && renaming !== g.id && (
                  <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                    <IconButton title="Rename category" onClick={() => setRenaming(g.id)}>
                      <Pencil size={13} />
                    </IconButton>
                    <IconButton title="Delete category" onClick={remove}>
                      <Trash2 size={13} />
                    </IconButton>
                  </span>
                )}
              </div>
              {open && (
                <ul className="ml-[15px] border-l border-line/60 pl-1">
                  {g.items.length === 0 && <li className="px-2 py-1.5 text-[12px] text-muted">Empty. Use “Move to” on a favorite to put it here.</li>}
                  {g.items.map((f) => (
                    <FavoriteRow key={f.id} fav={f} tab={tab} active={visible[active]?.id === f.id} onHover={() => setActive(visible.indexOf(f))} onClose={onClose} />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <div className="border-t border-line px-3 py-1.5 text-[11px] text-muted">Click or Enter inserts at the cursor · Shift+Enter opens a new tab · right-click for more</div>
    </div>
  );
}

async function deleteCategory(id: string, name: string, count: number) {
  const msg = count > 0 ? `Delete the category "${name}"? Its ${count} favorite${count === 1 ? "" : "s"} will move to Uncategorized.` : `Delete the category "${name}"?`;
  const ok = await ask(msg, { title: "Delete category", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" });
  if (ok) st().removeFavoriteCategory(id);
}

function FavoriteRow({ fav: f, tab, active, onHover, onClose }: { fav: FavoriteQuery; tab: EditorTab; active: boolean; onHover: () => void; onClose: () => void }) {
  const conn = useStore((s) => s.connections.find((c) => c.id === baseId(f.connId)));
  const leave = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
    onClose();
  };
  const stay = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <li
      data-active={active || undefined}
      onMouseEnter={onHover}
      onClick={leave(() => insertFavorite(tab, f))}
      onContextMenu={(e) => st().openContextMenu(e, favoriteMenu(tab, f, onClose))}
      title="Click to insert at the cursor"
      className={cx("group flex cursor-pointer gap-2.5 rounded-md px-2 py-1.5", active && "bg-accent-soft")}
    >
      <Star size={14} className="mt-0.5 shrink-0 text-warn" fill="currentColor" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="truncate font-medium text-fg">{f.name}</span>
          {conn && <span className="shrink-0 text-[11px] text-muted">· {conn.name}</span>}
        </div>
        <pre className="line-clamp-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-2">{f.sql}</pre>
      </div>
      <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <IconButton title="Open in new tab" onClick={leave(() => openInNewTab(tab, f))}>
          <SquarePlus size={14} />
        </IconButton>
        <IconButton title="Run" onClick={leave(() => void st().runTab(tab.id, f.sql))}>
          <Play size={14} />
        </IconButton>
        <IconButton title="Edit" onClick={stay(() => st().setUi({ favoriteDialog: { favorite: f } }))}>
          <Pencil size={14} />
        </IconButton>
        <IconButton title="Delete" onClick={stay(() => void deleteFavorite(f))}>
          <Trash2 size={14} />
        </IconButton>
      </div>
    </li>
  );
}

/** Inline name input: Enter or blur saves, Escape cancels (onDone("")). */
function NameInput({ initial, placeholder, onDone }: { initial: string; placeholder: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value.trim())}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(value.trim());
        else if (e.key === "Escape") onDone("");
      }}
      className="h-6 w-56 rounded border border-accent bg-bg/40 px-1.5 text-[12.5px] font-normal text-fg outline-none"
    />
  );
}

const NEW_CATEGORY = "__new__";

export function FavoriteDialogHost() {
  const dlg = useStore((s) => s.favoriteDialog);
  if (!dlg) return null;
  return <FavoriteDialogView key={dlg.favorite.id ?? "new"} />;
}

function FavoriteDialogView() {
  const { favorite } = useStore((s) => s.favoriteDialog)!;
  const categories = useStore((s) => s.favoriteCategories);
  const close = () => st().setUi({ favoriteDialog: null });
  const editing = !!favorite.id;
  const [name, setName] = useState(favorite.name ?? "");
  const [sql, setSql] = useState(favorite.sql);
  const [category, setCategory] = useState<string>(favorite.categoryId ?? (editing ? UNCATEGORIZED : (lastCategory() ?? UNCATEGORIZED)));
  const [newCategory, setNewCategory] = useState("");

  const valid = name.trim() && sql.trim() && (category !== NEW_CATEGORY || newCategory.trim());

  const save = () => {
    if (!valid) return;
    let categoryId: string | null = category === UNCATEGORIZED ? null : category;
    if (category === NEW_CATEGORY) categoryId = st().addFavoriteCategory(newCategory);
    rememberCategory(categoryId);
    st().saveFavorite({ ...favorite, name: name.trim(), sql: sql.trim(), categoryId });
    close();
  };

  return (
    <Modal title={editing ? "Edit favorite" : "Add to favorites"} onClose={close} width={560}>
      <form
        className="space-y-4 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-[12px] text-muted">Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} spellCheck={false} className={field} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className="text-[12px] text-muted">Category</span>
            <select className={field} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value={UNCATEGORIZED}>Uncategorized</option>
              {[...categories]
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              <option value={NEW_CATEGORY}>New category…</option>
            </select>
          </label>
          {category === NEW_CATEGORY && (
            <label className="block space-y-1.5">
              <span className="text-[12px] text-muted">New category name</span>
              <input autoFocus value={newCategory} onChange={(e) => setNewCategory(e.target.value)} spellCheck={false} className={field} />
            </label>
          )}
        </div>
        <label className="block space-y-1.5">
          <span className="text-[12px] text-muted">SQL</span>
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={Math.min(14, Math.max(4, sql.split("\n").length + 1))}
            spellCheck={false}
            className={cx("w-full resize-y rounded-md border border-line-strong bg-bg/50 p-3 font-mono text-[12.5px] text-fg outline-none focus:border-accent")}
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid}>
            <Star size={15} /> {editing ? "Save" : "Add to favorites"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// The category picked last is preselected for the next favorite.
const LAST_CATEGORY_KEY = "favorites:lastCategory";

function lastCategory(): string | null {
  try {
    const id = localStorage.getItem(LAST_CATEGORY_KEY);
    return id && st().favoriteCategories.some((c) => c.id === id) ? id : null;
  } catch {
    return null;
  }
}

function rememberCategory(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_CATEGORY_KEY, id);
    else localStorage.removeItem(LAST_CATEGORY_KEY);
  } catch {
    // storage unavailable
  }
}
