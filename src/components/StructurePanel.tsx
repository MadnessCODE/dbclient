// Structure tab: columns, indexes, foreign keys, DDL and info for the active tab's table, editable.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Copy,
  FileCode,
  Info,
  KeyRound,
  Link2,
  ListTree,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Sheet,
  Trash2,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { api, errorText, type DbKind, type SchemaTree, type TableStructure } from "../lib/api";
import {
  buildAlter,
  changedFields,
  COMMON_TYPES,
  countChanges,
  emptyEdits,
  FK_RULES,
  isTextType,
  isTimeType,
  splitExtra,
  type EditColumn,
  type NewForeignKey,
  type NewIndex,
  type StructureEdits,
} from "../lib/alter";
import { useStore, type EditorTab, type TableRef } from "../store";
import { isProduction } from "../lib/connStyle";
import { Button, cx, IconButton, Modal, Spinner } from "./ui";

type Section = "columns" | "indexes" | "foreignKeys" | "ddl" | "info";

/** The tab's table: remembered, or the first after FROM/UPDATE/INTO, resolved through the schema tree. */
export function resolveTable(tab: EditorTab, schema: SchemaTree | undefined, defaultDb?: string): TableRef | null {
  if (tab.table) return tab.table;
  const m = /\b(?:from|update|into|table)\s+([`"\w$]+(?:\.[`"\w$]+)?)/i.exec(tab.sql);
  if (!m || !schema) return null;
  const parts = m[1].replace(/[`"]/g, "").split(".");
  const name = parts.pop()!;
  const wanted = parts[0];
  const has = (s: SchemaTree["schemas"][number]) =>
    [...s.tables, ...s.views, ...s.matViews].some((t) => t.toLowerCase() === name.toLowerCase());
  const candidates = schema.schemas.filter((s) => (!wanted || s.name === wanted) && has(s));
  const pick = candidates.find((s) => s.name === defaultDb) ?? candidates.find((s) => !s.system) ?? candidates[0];
  if (!pick) return null;
  const real = [...pick.tables, ...pick.views, ...pick.matViews].find((t) => t.toLowerCase() === name.toLowerCase())!;
  return { schema: pick.name, table: real };
}

export function StructurePanel({ tab }: { tab: EditorTab }) {
  const cfg = useStore((s) => s.connections.find((c) => c.id === tab.connId));
  const connState = useStore((s) => (tab.connId ? s.conn[tab.connId] : undefined));
  const target = resolveTable(tab, connState?.schema, connState?.info?.database);

  if (!cfg) return <Centered text="Select a connection for this tab first." />;
  if (connState?.status !== "connected") return <Centered text="Connect to the database to see table structure." />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TablePicker tab={tab} schema={connState.schema} target={target} />
      {target ? (
        <StructureView key={`${tab.connId}:${target.schema}.${target.table}`} connId={cfg.id} kind={cfg.kind} target={target} schemaTree={connState.schema} />
      ) : (
        <Centered text="Pick a table above, or open one from the schema tree." />
      )}
    </div>
  );
}

function Centered({ text }: { text: string }) {
  return <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted">{text}</div>;
}

function TablePicker({ tab, schema, target }: { tab: EditorTab; schema?: SchemaTree; target: TableRef | null }) {
  const options = useMemo(() => {
    const out: { value: string; label: string; group: string }[] = [];
    for (const s of schema?.schemas ?? []) {
      if (s.system) continue;
      for (const t of s.tables) out.push({ value: `${s.name}\u0000${t}`, label: t, group: `${s.name} · tables` });
      for (const v of [...s.views, ...s.matViews]) out.push({ value: `${s.name}\u0000${v}`, label: v, group: `${s.name} · views` });
    }
    return out;
  }, [schema]);
  const groups = [...new Set(options.map((o) => o.group))];
  const value = target ? `${target.schema}\u0000${target.table}` : "";

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 px-3.5">
      <Sheet size={16} className="text-muted" />
      <span className="text-[13px] text-muted">Table</span>
      <select
        value={value}
        onChange={(e) => {
          const [schemaName, table] = e.target.value.split("\u0000");
          useStore.getState().updateTab(tab.id, { table: { schema: schemaName, table } });
        }}
        className="h-8 max-w-[320px] min-w-[200px] rounded-md border border-line-strong bg-panel px-2 text-[13px] text-fg outline-none focus:border-accent"
      >
        {!target && <option value="">Select table…</option>}
        {target && !options.some((o) => o.value === value) && <option value={value}>{`${target.schema}.${target.table}`}</option>}
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {options
              .filter((o) => o.group === g)
              .map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}


function StructureView({ connId, kind, target, schemaTree }: { connId: string; kind: DbKind; target: TableRef; schemaTree?: SchemaTree }) {
  const [st, setSt] = useState<TableStructure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<StructureEdits | null>(null);
  const [section, setSection] = useState<Section>("columns");
  const [preview, setPreview] = useState<string[] | null>(null);
  const [collations, setCollations] = useState<string[]>([]);

  useEffect(() => {
    api.listCollations(connId).then(setCollations, () => setCollations([]));
  }, [connId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getTableStructure(connId, target.schema, target.table);
      setSt(data);
      setEdits(emptyEdits(data));
    } catch (e) {
      setError(errorText(e));
    }
    setLoading(false);
  }, [connId, target.schema, target.table]);

  useEffect(() => {
    void load();
  }, [load]);

  // Ctrl+S outside the editor opens the save preview
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
      if ((document.activeElement as HTMLElement | null)?.closest(".monaco-editor")) return;
      if (!st || !edits || countChanges(edits) === 0 || preview) return;
      e.preventDefault();
      setPreview(buildAlter(kind, st, edits));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [st, edits, kind, preview]);

  if (loading && !st)
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted">
        <Spinner /> Loading structure…
      </div>
    );
  if (error) return <Centered text={error} />;
  if (!st || !edits) return null;

  const changes = countChanges(edits);
  const readOnly = st.isView;
  const sections: { key: Section; label: string; icon: typeof Sheet; count?: number }[] = [
    { key: "columns", label: "Columns", icon: Sheet, count: st.columns.length },
    { key: "indexes", label: "Indexes", icon: KeyRound, count: st.indexes.length },
    { key: "foreignKeys", label: "Foreign Keys", icon: Link2, count: st.foreignKeys.length + st.referencedBy.length },
    { key: "ddl", label: "DDL", icon: FileCode },
    { key: "info", label: "Info", icon: Info },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-3">
        {sections.map(({ key, label, icon: Icon, count }) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            className={cx(
              "flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px]",
              section === key ? "bg-accent-soft text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
            )}
          >
            <Icon size={14} className={section === key ? "text-accent" : "text-muted"} />
            {label}
            {count !== undefined && <span className="text-[11px] text-muted">{count}</span>}
          </button>
        ))}
        {st.isView && <span className="ml-2 rounded bg-warn/15 px-2 py-0.5 text-[11px] text-warn">view · read-only</span>}
        <div className="ml-auto flex items-center gap-2">
          {changes > 0 && (
            <>
              <span className="text-[12px] text-warn">
                {changes} pending change{changes > 1 ? "s" : ""}
              </span>
              <Button className="h-7" variant="ghost" onClick={() => setEdits(emptyEdits(st))}>
                <RotateCcw size={14} /> Discard
              </Button>
              <Button className="h-7" variant="primary" onClick={() => setPreview(buildAlter(kind, st, edits))} title="Review the SQL and save (Ctrl+S)">
                <Save size={14} /> Save
              </Button>
            </>
          )}
          <IconButton title="Reload structure" onClick={() => void load()}>
            {loading ? <Spinner /> : <RefreshCw size={14} />}
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {section === "columns" && <ColumnsEditor kind={kind} edits={edits} setEdits={setEdits} readOnly={readOnly} collations={collations} />}
        {section === "indexes" && <IndexesEditor st={st} edits={edits} setEdits={setEdits} readOnly={readOnly} />}
        {section === "foreignKeys" && (
          <ForeignKeysEditor st={st} edits={edits} setEdits={setEdits} readOnly={readOnly} schemaTree={schemaTree} />
        )}
        {section === "ddl" && <DdlView connId={connId} ddl={st.ddl} title={`${st.table}.sql`} />}
        {section === "info" && <InfoView st={st} />}
      </div>

      {preview && (
        <PreviewDialog
          connId={connId}
          statements={preview}
          onClose={() => setPreview(null)}
          onDone={() => {
            setPreview(null);
            void load();
            void useStore.getState().refreshSchema(connId);
          }}
        />
      )}
    </div>
  );
}


const th = "sticky top-0 z-10 h-9 border-b border-line bg-raised px-2 text-left text-[11.5px] font-medium tracking-wide text-muted uppercase";
const cellInput =
  "h-7 w-full rounded border border-transparent bg-transparent px-1.5 text-[13px] text-fg outline-none hover:border-line-strong focus:border-accent focus:bg-bg/40 disabled:hover:border-transparent";

function ColumnsEditor({
  kind,
  edits,
  setEdits,
  readOnly,
  collations,
}: {
  kind: DbKind;
  edits: StructureEdits;
  setEdits: (e: StructureEdits) => void;
  readOnly: boolean;
  collations: string[];
}) {
  const my = kind === "mysql";
  const update = (key: string, patch: Partial<EditColumn>) =>
    setEdits({ ...edits, columns: edits.columns.map((c) => (c.key === key ? { ...c, ...patch } : c)) });

  const addColumn = () => {
    const n = edits.columns.filter((c) => !c.orig).length + 1;
    setEdits({
      ...edits,
      columns: [
        ...edits.columns,
        {
          key: `new${Date.now()}`,
          name: `new_column${n > 1 ? n : ""}`,
          type: kind === "mysql" ? "varchar(255)" : "character varying(255)",
          nullable: true,
          default: "",
          primaryKey: false,
          autoIncrement: false,
          comment: "",
          collation: "",
          onUpdate: "",
          deleted: false,
        },
      ],
    });
  };

  return (
    <div className="p-3">
      <datalist id={`types-${kind}`}>
        {COMMON_TYPES[kind].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <datalist id="collations">
        {collations.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id="on-update">
        <option value="CURRENT_TIMESTAMP" />
        <option value="CURRENT_TIMESTAMP(3)" />
        <option value="CURRENT_TIMESTAMP(6)" />
      </datalist>
      <table className="w-full border-collapse overflow-hidden rounded-md border border-line text-[13px]">
        <thead>
          <tr>
            <th className={cx(th, "w-10 text-center")}>#</th>
            <th className={cx(th, "w-[18%]")}>Name</th>
            <th className={cx(th, "w-[18%]")}>Type</th>
            <th className={cx(th, "w-20 text-center")}>Not null</th>
            <th className={cx(th, "w-[15%]")}>Default</th>
            <th className={cx(th, "w-12 text-center")} title="Primary key">PK</th>
            <th className={cx(th, "w-16 text-center")} title="Auto increment / identity">Auto inc</th>
            <th className={th}>Comment</th>
            <th className={cx(th, "w-[14%]")} title="Empty = table/database default">Collation</th>
            {my && <th className={cx(th, "w-[11%]")}>On update</th>}
            <th className={cx(th, "w-10")} />
          </tr>
        </thead>
        <tbody>
          {edits.columns.map((c, i) => {
            const ch = changedFields(c);
            const mark = (f: keyof EditColumn) => (ch.has(f) ? "bg-warn/10" : "");
            const isNew = !c.orig;
            return (
              <tr
                key={c.key}
                className={cx(
                  "border-b border-line/60",
                  c.deleted && "opacity-45 [&_input]:line-through",
                  isNew && "bg-ok/5",
                  !c.deleted && !isNew && ch.size > 0 && "shadow-[inset_3px_0_0_var(--warn)]",
                  isNew && "shadow-[inset_3px_0_0_var(--ok)]",
                )}
              >
                <td className="text-center text-[12px] text-muted">{i + 1}</td>
                <td className={cx("px-1", mark("name"))}>
                  <div className="flex items-center gap-1">
                    {c.primaryKey && <KeyRound size={12} className="shrink-0 text-warn" />}
                    <input className={cx(cellInput, "font-medium")} value={c.name} disabled={readOnly || c.deleted} onChange={(e) => update(c.key, { name: e.target.value })} spellCheck={false} />
                    {splitExtra(c.orig?.extra ?? null).rest && (
                      <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[10px] text-muted" title={splitExtra(c.orig?.extra ?? null).rest}>
                        {/identity/i.test(c.orig?.extra ?? "") ? "identity" : "generated"}
                      </span>
                    )}
                  </div>
                </td>
                <td className={cx("px-1", mark("type"))}>
                  <input className={cx(cellInput, "font-mono text-[12.5px] text-[#6fd3ee]")} list={`types-${kind}`} value={c.type} disabled={readOnly || c.deleted} onChange={(e) => update(c.key, { type: e.target.value })} spellCheck={false} />
                </td>
                <td className={cx("text-center", mark("nullable"))}>
                  <input type="checkbox" className="accent-[var(--accent)]" checked={!c.nullable} disabled={readOnly || c.deleted} onChange={(e) => update(c.key, { nullable: !e.target.checked })} />
                </td>
                <td className={cx("px-1", mark("default"))}>
                  <input className={cx(cellInput, "font-mono text-[12.5px]")} value={c.default} placeholder="—" disabled={readOnly || c.deleted} onChange={(e) => update(c.key, { default: e.target.value })} spellCheck={false} title="SQL expression, e.g. 'text', 0, now()" />
                </td>
                <td className={cx("text-center", mark("primaryKey"))}>
                  <input type="checkbox" className="accent-[var(--accent)]" checked={c.primaryKey} disabled={readOnly || c.deleted} onChange={(e) => update(c.key, { primaryKey: e.target.checked, nullable: e.target.checked ? false : c.nullable })} />
                </td>
                <td className={cx("text-center", mark("autoIncrement"))}>
                  <input type="checkbox" className="accent-[var(--accent)]" checked={c.autoIncrement} disabled={readOnly || c.deleted} onChange={(e) => update(c.key, { autoIncrement: e.target.checked })} />
                </td>
                <td className={cx("px-1", mark("comment"))}>
                  <input className={cellInput} value={c.comment} disabled={readOnly || c.deleted} onChange={(e) => update(c.key, { comment: e.target.value })} />
                </td>
                <td className={cx("px-1", mark("collation"))}>
                  <input
                    className={cx(cellInput, "text-[12px]")}
                    list="collations"
                    value={c.collation}
                    placeholder={isTextType(c.type) ? "default" : ""}
                    disabled={readOnly || c.deleted || !isTextType(c.type)}
                    onChange={(e) => update(c.key, { collation: e.target.value })}
                    spellCheck={false}
                  />
                </td>
                {my && (
                  <td className={cx("px-1", mark("onUpdate"))}>
                    <input
                      className={cx(cellInput, "font-mono text-[12px]")}
                      list="on-update"
                      value={c.onUpdate}
                      placeholder={isTimeType(c.type) ? "—" : ""}
                      disabled={readOnly || c.deleted || !isTimeType(c.type)}
                      onChange={(e) => update(c.key, { onUpdate: e.target.value })}
                      spellCheck={false}
                    />
                  </td>
                )}
                <td className="text-center">
                  {!readOnly &&
                    (c.deleted ? (
                      <IconButton title="Undo delete" onClick={() => update(c.key, { deleted: false })}>
                        <Undo2 size={14} />
                      </IconButton>
                    ) : (
                      <IconButton
                        title={isNew ? "Remove" : "Drop column"}
                        onClick={() =>
                          isNew ? setEdits({ ...edits, columns: edits.columns.filter((x) => x.key !== c.key) }) : update(c.key, { deleted: true })
                        }
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!readOnly && (
        <Button className="mt-3 h-8" onClick={addColumn}>
          <Plus size={15} /> Add column
        </Button>
      )}
    </div>
  );
}


function IndexesEditor({ st, edits, setEdits, readOnly }: { st: TableStructure; edits: StructureEdits; setEdits: (e: StructureEdits) => void; readOnly: boolean }) {
  const [adding, setAdding] = useState<NewIndex | null>(null);
  const columnNames = edits.columns.filter((c) => !c.deleted).map((c) => c.name);
  const toggleDrop = (name: string) =>
    setEdits({
      ...edits,
      droppedIndexes: edits.droppedIndexes.includes(name) ? edits.droppedIndexes.filter((n) => n !== name) : [...edits.droppedIndexes, name],
    });

  return (
    <div className="space-y-3 p-3">
      <table className="w-full border-collapse rounded-md border border-line text-[13px]">
        <thead>
          <tr>
            <th className={th}>Name</th>
            <th className={th}>Columns</th>
            <th className={cx(th, "w-28")}>Kind</th>
            <th className={cx(th, "w-24")}>Method</th>
            <th className={cx(th, "w-10")} />
          </tr>
        </thead>
        <tbody>
          {st.indexes.map((ix) => {
            const dropped = edits.droppedIndexes.includes(ix.name);
            return (
              <tr key={ix.name} className={cx("h-9 border-b border-line/60", dropped && "line-through opacity-45")}>
                <td className="px-2 font-medium">
                  <span className="flex items-center gap-1.5">
                    {ix.primary && <KeyRound size={13} className="text-warn" />}
                    {ix.name}
                  </span>
                </td>
                <td className="px-2 font-mono text-[12.5px] text-fg-2">{ix.columns.join(", ")}</td>
                <td className="px-2">
                  <IndexBadge primary={ix.primary} unique={ix.unique} />
                </td>
                <td className="px-2 text-[12px] text-muted">{ix.method}</td>
                <td className="text-center">
                  {!readOnly && !ix.primary && (
                    <IconButton title={dropped ? "Undo" : "Drop index"} onClick={() => toggleDrop(ix.name)}>
                      {dropped ? <Undo2 size={14} /> : <Trash2 size={14} />}
                    </IconButton>
                  )}
                </td>
              </tr>
            );
          })}
          {edits.newIndexes.map((ix) => (
            <tr key={ix.key} className="h-9 border-b border-line/60 bg-ok/5 shadow-[inset_3px_0_0_var(--ok)]">
              <td className="px-2 font-medium">{ix.name}</td>
              <td className="px-2 font-mono text-[12.5px] text-fg-2">{ix.columns.join(", ")}</td>
              <td className="px-2">
                <IndexBadge primary={false} unique={ix.unique} />
              </td>
              <td className="px-2 text-[12px] text-muted">new</td>
              <td className="text-center">
                <IconButton title="Remove" onClick={() => setEdits({ ...edits, newIndexes: edits.newIndexes.filter((x) => x.key !== ix.key) })}>
                  <Trash2 size={14} />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11.5px] text-muted">Primary key is changed from the Columns tab (PK checkbox).</p>

      {!readOnly &&
        (adding ? (
          <div className="space-y-3 rounded-md border border-line-strong bg-panel p-3">
            <div className="flex items-center gap-3">
              <input
                className="h-8 w-64 rounded-md border border-line-strong bg-bg/40 px-2 text-[13px] outline-none focus:border-accent"
                value={adding.name}
                onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                placeholder="index name"
              />
              <label className="flex items-center gap-1.5 text-[13px]">
                <input type="checkbox" className="accent-[var(--accent)]" checked={adding.unique} onChange={(e) => setAdding({ ...adding, unique: e.target.checked })} /> Unique
              </label>
            </div>
            <ColumnChips all={columnNames} selected={adding.columns} onChange={(cols) => setAdding({ ...adding, columns: cols, name: adding.name || "" })} />
            <div className="flex gap-2">
              <Button
                variant="primary"
                className="h-8"
                disabled={!adding.name.trim() || adding.columns.length === 0}
                onClick={() => {
                  setEdits({ ...edits, newIndexes: [...edits.newIndexes, adding] });
                  setAdding(null);
                }}
              >
                Add
              </Button>
              <Button variant="ghost" className="h-8" onClick={() => setAdding(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button className="h-8" onClick={() => setAdding({ key: `ix${Date.now()}`, name: `idx_${st.table}_`, columns: [], unique: false })}>
            <Plus size={15} /> Add index
          </Button>
        ))}
    </div>
  );
}

function IndexBadge({ primary, unique }: { primary: boolean; unique: boolean }) {
  const [label, cls] = primary ? ["PRIMARY", "bg-warn/15 text-warn"] : unique ? ["UNIQUE", "bg-accent-soft text-accent"] : ["INDEX", "bg-hover text-fg-2"];
  return <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-medium", cls)}>{label}</span>;
}

/** Column picker that keeps click order (matters for indexes/FKs). */
function ColumnChips({ all, selected, onChange }: { all: string[]; selected: string[]; onChange: (cols: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {all.map((c) => {
        const idx = selected.indexOf(c);
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(idx >= 0 ? selected.filter((x) => x !== c) : [...selected, c])}
            className={cx(
              "flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[12px]",
              idx >= 0 ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-fg-2 hover:bg-hover",
            )}
          >
            {idx >= 0 && <span className="text-[10px] text-accent">{idx + 1}</span>}
            {c}
          </button>
        );
      })}
    </div>
  );
}


function ForeignKeysEditor({
  st,
  edits,
  setEdits,
  readOnly,
  schemaTree,
}: {
  st: TableStructure;
  edits: StructureEdits;
  setEdits: (e: StructureEdits) => void;
  readOnly: boolean;
  schemaTree?: SchemaTree;
}) {
  const [adding, setAdding] = useState<NewForeignKey | null>(null);
  const columnNames = edits.columns.filter((c) => !c.deleted).map((c) => c.name);
  const openTable = (schema: string, table: string) => {
    const tab = useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTabId);
    if (tab) useStore.getState().updateTab(tab.id, { table: { schema, table } });
  };
  const toggleDrop = (name: string) =>
    setEdits({
      ...edits,
      droppedForeignKeys: edits.droppedForeignKeys.includes(name) ? edits.droppedForeignKeys.filter((n) => n !== name) : [...edits.droppedForeignKeys, name],
    });

  const refTables = (schemaTree?.schemas ?? []).filter((s) => !s.system).flatMap((s) => s.tables.map((t) => ({ schema: s.name, table: t })));
  const refColumns = adding ? (schemaTree?.columns ?? []).filter((c) => c.schema === adding.refSchema && c.table === adding.refTable).map((c) => c.name) : [];

  return (
    <div className="space-y-4 p-3">
      <section>
        <h4 className="mb-2 flex items-center gap-2 text-[12px] font-medium text-muted uppercase">
          <ArrowRight size={13} /> References (this table → other)
        </h4>
        <table className="w-full border-collapse rounded-md border border-line text-[13px]">
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Columns</th>
              <th className={th}>References</th>
              <th className={cx(th, "w-28")}>On update</th>
              <th className={cx(th, "w-28")}>On delete</th>
              <th className={cx(th, "w-10")} />
            </tr>
          </thead>
          <tbody>
            {st.foreignKeys.length === 0 && edits.newForeignKeys.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-3 text-center text-[12px] text-muted">
                  No foreign keys
                </td>
              </tr>
            )}
            {st.foreignKeys.map((fk) => {
              const dropped = edits.droppedForeignKeys.includes(fk.name);
              return (
                <tr key={fk.name} className={cx("h-9 border-b border-line/60", dropped && "line-through opacity-45")}>
                  <td className="px-2 font-medium">{fk.name}</td>
                  <td className="px-2 font-mono text-[12.5px] text-fg-2">{fk.columns.join(", ")}</td>
                  <td className="px-2">
                    <button className="font-mono text-[12.5px] text-accent hover:underline" onClick={() => openTable(fk.refSchema, fk.refTable)}>
                      {fk.refSchema !== st.schema && `${fk.refSchema}.`}
                      {fk.refTable} ({fk.refColumns.join(", ")})
                    </button>
                  </td>
                  <td className="px-2 text-[12px] text-fg-2">{fk.onUpdate}</td>
                  <td className="px-2 text-[12px] text-fg-2">{fk.onDelete}</td>
                  <td className="text-center">
                    {!readOnly && (
                      <IconButton title={dropped ? "Undo" : "Drop foreign key"} onClick={() => toggleDrop(fk.name)}>
                        {dropped ? <Undo2 size={14} /> : <Trash2 size={14} />}
                      </IconButton>
                    )}
                  </td>
                </tr>
              );
            })}
            {edits.newForeignKeys.map((fk) => (
              <tr key={fk.key} className="h-9 border-b border-line/60 bg-ok/5 shadow-[inset_3px_0_0_var(--ok)]">
                <td className="px-2 font-medium">{fk.name}</td>
                <td className="px-2 font-mono text-[12.5px] text-fg-2">{fk.columns.join(", ")}</td>
                <td className="px-2 font-mono text-[12.5px]">
                  {fk.refTable} ({fk.refColumns.join(", ")})
                </td>
                <td className="px-2 text-[12px]">{fk.onUpdate}</td>
                <td className="px-2 text-[12px]">{fk.onDelete}</td>
                <td className="text-center">
                  <IconButton title="Remove" onClick={() => setEdits({ ...edits, newForeignKeys: edits.newForeignKeys.filter((x) => x.key !== fk.key) })}>
                    <Trash2 size={14} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!readOnly &&
          (adding ? (
            <div className="mt-3 space-y-3 rounded-md border border-line-strong bg-panel p-3 text-[13px]">
              <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5">
                <span className="text-muted">Name</span>
                <input className="h-8 w-72 rounded-md border border-line-strong bg-bg/40 px-2 outline-none focus:border-accent" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
                <span className="text-muted">Columns</span>
                <ColumnChips all={columnNames} selected={adding.columns} onChange={(cols) => setAdding({ ...adding, columns: cols })} />
                <span className="text-muted">References</span>
                <select
                  className="h-8 w-72 rounded-md border border-line-strong bg-panel px-2 outline-none focus:border-accent"
                  value={adding.refTable ? `${adding.refSchema}\u0000${adding.refTable}` : ""}
                  onChange={(e) => {
                    const [refSchema, refTable] = e.target.value.split("\u0000");
                    setAdding({ ...adding, refSchema, refTable, refColumns: [] });
                  }}
                >
                  <option value="">Select table…</option>
                  {refTables.map((t) => (
                    <option key={`${t.schema}.${t.table}`} value={`${t.schema}\u0000${t.table}`}>
                      {t.schema}.{t.table}
                    </option>
                  ))}
                </select>
                <span className="text-muted">Ref. columns</span>
                {adding.refTable ? (
                  <ColumnChips all={refColumns} selected={adding.refColumns} onChange={(cols) => setAdding({ ...adding, refColumns: cols })} />
                ) : (
                  <span className="text-[12px] text-muted">pick a table first</span>
                )}
                <span className="text-muted">On update</span>
                <RuleSelect value={adding.onUpdate} onChange={(v) => setAdding({ ...adding, onUpdate: v })} />
                <span className="text-muted">On delete</span>
                <RuleSelect value={adding.onDelete} onChange={(v) => setAdding({ ...adding, onDelete: v })} />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  className="h-8"
                  disabled={!adding.name.trim() || !adding.refTable || adding.columns.length === 0 || adding.columns.length !== adding.refColumns.length}
                  onClick={() => {
                    setEdits({ ...edits, newForeignKeys: [...edits.newForeignKeys, adding] });
                    setAdding(null);
                  }}
                >
                  Add
                </Button>
                <Button variant="ghost" className="h-8" onClick={() => setAdding(null)}>
                  Cancel
                </Button>
                {adding.columns.length !== adding.refColumns.length && adding.refColumns.length > 0 && (
                  <span className="self-center text-[12px] text-warn">Column counts must match</span>
                )}
              </div>
            </div>
          ) : (
            <Button
              className="mt-3 h-8"
              onClick={() =>
                setAdding({ key: `fk${Date.now()}`, name: `fk_${st.table}_`, columns: [], refSchema: st.schema, refTable: "", refColumns: [], onUpdate: "NO ACTION", onDelete: "NO ACTION" })
              }
            >
              <Plus size={15} /> Add foreign key
            </Button>
          ))}
      </section>

      <section>
        <h4 className="mb-2 flex items-center gap-2 text-[12px] font-medium text-muted uppercase">
          <ArrowRight size={13} className="rotate-180" /> Referenced by (other → this table)
        </h4>
        <table className="w-full border-collapse rounded-md border border-line text-[13px]">
          <thead>
            <tr>
              <th className={th}>Table</th>
              <th className={th}>Columns</th>
              <th className={th}>Constraint</th>
              <th className={cx(th, "w-28")}>On update</th>
              <th className={cx(th, "w-28")}>On delete</th>
            </tr>
          </thead>
          <tbody>
            {st.referencedBy.length === 0 && (
              <tr>
                <td colSpan={5} className="px-2 py-3 text-center text-[12px] text-muted">
                  No other table references this one
                </td>
              </tr>
            )}
            {st.referencedBy.map((fk) => (
              <tr key={`${fk.table}.${fk.name}`} className="h-9 border-b border-line/60">
                <td className="px-2">
                  <button className="text-accent hover:underline" onClick={() => openTable(fk.tableSchema, fk.table)}>
                    {fk.tableSchema !== st.schema && `${fk.tableSchema}.`}
                    {fk.table}
                  </button>
                </td>
                <td className="px-2 font-mono text-[12.5px] text-fg-2">
                  {fk.columns.join(", ")} → {fk.refColumns.join(", ")}
                </td>
                <td className="px-2 text-fg-2">{fk.name}</td>
                <td className="px-2 text-[12px] text-fg-2">{fk.onUpdate}</td>
                <td className="px-2 text-[12px] text-fg-2">{fk.onDelete}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function RuleSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select className="h-8 w-44 rounded-md border border-line-strong bg-panel px-2 outline-none focus:border-accent" value={value} onChange={(e) => onChange(e.target.value)}>
      {FK_RULES.map((r) => (
        <option key={r}>{r}</option>
      ))}
    </select>
  );
}


function DdlView({ connId, ddl, title }: { connId: string; ddl: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="p-3">
      <div className="mb-2 flex gap-2">
        <Button
          className="h-8"
          onClick={() => {
            void navigator.clipboard.writeText(ddl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          <Copy size={14} /> {copied ? "Copied!" : "Copy"}
        </Button>
        <Button className="h-8" onClick={() => useStore.getState().newTab({ sql: ddl, connId, title: `ddl_${title}` })}>
          <ListTree size={14} /> Open in editor
        </Button>
      </div>
      <pre className="selectable overflow-auto rounded-md border border-line bg-bg/40 p-4 font-mono text-[12.5px] leading-relaxed text-fg-2">{ddl}</pre>
    </div>
  );
}

function formatBytes(b: string | null) {
  const n = Number(b);
  if (!b || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function InfoView({ st }: { st: TableStructure }) {
  const rows: [string, string][] = [
    ["Schema", st.schema],
    ["Name", st.table],
    ["Type", st.isView ? "View" : "Table"],
    ["Engine", st.engine ?? "—"],
    ["Rows (estimate)", st.rowEstimate ? Number(st.rowEstimate).toLocaleString() : "—"],
    ["Size (data + indexes)", formatBytes(st.sizeBytes)],
    ["Collation", st.collation ?? "—"],
    ["Comment", st.tableComment ?? "—"],
    ["Columns", String(st.columns.length)],
    ["Indexes", String(st.indexes.length)],
    ["Foreign keys", `${st.foreignKeys.length} outgoing, ${st.referencedBy.length} incoming`],
  ];
  return (
    <dl className="grid max-w-[640px] grid-cols-[200px_1fr] gap-y-2.5 p-5 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="selectable text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}


function PreviewDialog({ connId, statements, onClose, onDone }: { connId: string; statements: string[]; onClose: () => void; onDone: () => void }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sql = statements.join("\n\n");

  const execute = async () => {
    setRunning(true);
    setError(null);
    try {
      await api.runQuery(connId, crypto.randomUUID(), sql, 10);
      onDone();
    } catch (e) {
      setError(errorText(e));
      setRunning(false);
    }
  };

  return (
    <Modal title="Save changes" onClose={onClose} width={720}>
      <div className="space-y-3 px-5 py-4">
{isProduction(useStore.getState().connections.find((c) => c.id === connId)) && (
          <p className="flex items-center gap-2 rounded-md bg-err/15 px-3 py-2 text-[13px] font-medium text-err">
            <TriangleAlert size={15} /> This runs on a PRODUCTION database.
          </p>
        )}
        <p className="text-[13px] text-fg-2">This SQL will be executed to save your changes:</p>
        <pre className="selectable max-h-[50vh] overflow-auto rounded-md border border-line bg-bg/50 p-4 font-mono text-[12.5px] leading-relaxed text-fg">{sql || "-- no changes"}</pre>
        {error && <p className="selectable rounded-md bg-err/10 px-3 py-2 text-[13px] text-err">{error}</p>}
        <div className="flex items-center gap-2 border-t border-line pt-4">
          <Button
            onClick={() => {
              useStore.getState().newTab({ sql, connId, title: "alter.sql" });
              onClose();
            }}
          >
            <FileCode size={15} /> Copy to editor
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void execute()} disabled={running || statements.length === 0}>
            {running ? <Spinner /> : <Save size={15} />} Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
