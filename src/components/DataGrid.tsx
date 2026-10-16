// Results grid: typed rendering, sorting, Excel-like selection and transactional edits.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ask } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  BetweenHorizontalEnd,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  ClipboardPaste,
  Clock,
  Copy,
  Eraser,
  Filter,
  FilterX,
  Link2,
  MoveHorizontal,
  Lock,
  PencilLine,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { api, errorText, type Cell, type ColumnRef, type DbKind, type ResultSet, type TableStructure } from "../lib/api";
import { cellKind, isTruthy, relativeTime, unixTsColumn, unixTsInfo, type CellKind, type TsUnit } from "../lib/cellKind";
import { isProduction } from "../lib/connStyle";
import { buildDml, editTargetOf, emptyPending, pendingCount, type EditTarget, type PendingEdits, type RowKey } from "../lib/edit";
import { quoteIdent } from "../lib/sql";
import { editorDb, editorName } from "../lib/treeActions";
import { exportableQuery, gridViews, type SortKey } from "../lib/export";
import { canInject, filterCondition, filtersActive, ident, pgAsText, topValuesQuery, viewQuery, type ColumnFilter, type FilterOp, type GridFilters } from "../lib/filter";
import { setEditorText } from "../lib/editorBridge";
import { tabDatabase, useStore, type MenuEntry } from "../store";
import { FilterBar, FilterPopover, type FilterColumn, type TopValue } from "./FilterBar";
import { CellEditor } from "./CellEditor";
import { BulkSetDialog, ValueModal } from "./ValueModal";
import { Button, cx, IconButton, Modal, Spinner, MOD } from "./ui";
import { baseId } from "../lib/connIds";

const ROW_H = 32;
const GUTTER_W = 22;
const MIN_COL_W = 50;

/** Column width from its name, type and values (first rows). */
function fitWidth(rs: ResultSet, ci: number, maxChars: number, maxW: number) {
  const col = rs.columns[ci];
  let len = Math.max(col.name.length, col.typeName.length);
  for (let r = 0; r < Math.min(rs.rows.length, 300); r++) len = Math.max(len, Math.min(rs.rows[r][ci]?.length ?? 4, maxChars));
  return Math.round(Math.min(maxW, Math.max(90, len * 7.4 + 32))) + (col.fk ? 22 : 0);
}
const PAGE_SIZES = [10, 25, 50, 100, 500, 1000];

/** Displayed row: existing (index into rs.rows) or new. */
type DisplayRow = { key: RowKey; existing: number | null };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortIndexes(rows: Cell[][], keys: SortKey[], numeric: boolean[]): number[] {
  const idx = rows.map((_, i) => i);
  if (!keys.length) return idx;
  idx.sort((ia, ib) => {
    const a = rows[ia];
    const b = rows[ib];
    for (const { col, dir } of keys) {
      const x = a[col];
      const y = b[col];
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      let c: number;
      if (numeric[col]) {
        const nx = Number(x);
        const ny = Number(y);
        c = Number.isNaN(nx) || Number.isNaN(ny) ? collator.compare(x, y) : nx - ny;
      } else c = collator.compare(x, y);
      if (c !== 0) return dir === "asc" ? c : -c;
    }
    return 0;
  });
  return idx;
}

/** Opens the referenced row in a new tab. */
function followFk(connId: string, kind: DbKind, fk: ColumnRef, value: string, numericValue: boolean) {
  const literal = numericValue && /^-?\d+(\.\d+)?$/.test(value) ? value : `'${(kind === "mysql" ? value.replace(/\\/g, "\\\\") : value).replace(/'/g, "''")}'`;
  const sql = `SELECT *\nFROM ${editorName(kind, fk.schema, fk.table)}\nWHERE ${quoteIdent(fk.column, kind)} = ${literal};`;
  useStore.getState().newTab({ sql, connId, database: editorDb(kind, fk.schema), title: `${fk.table}.sql`, run: true, table: { schema: fk.schema, table: fk.table } });
}

const cellId = (r: number, c: number) => `${r}:${c}`;

export function DataGrid({ rs, connId, kind, tabId }: { rs: ResultSet; connId: string | null; kind: DbKind; tabId: string }) {
  const pageSize = useStore((s) => s.settings.pageSize);
  const setSettings = useStore((s) => s.setSettings);
  const cfg = useStore((s) => s.connections.find((c) => c.id === baseId(connId)));
  const [page, setPage] = useState(0);
  // the grid remounts per query, so a database sort comes back through the runtime
  const [ran] = useState(() => {
    const rt = useStore.getState().runtime[tabId];
    return { base: rt?.filters?.base ?? rt?.serverSort?.base ?? rt?.lastSql, sort: rt?.serverSort?.keys ?? [], filters: rt?.filters };
  });
  const [filterPop, setFilterPop] = useState<{ col: number; filter: ColumnFilter; anchor: DOMRect; isNew: boolean } | null>(null);
  const [sort, setSort] = useState<SortKey[]>(ran.sort);
  const [pending, setPending] = useState<PendingEdits>(emptyPending);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  // anchor is a ref so dragging sees it before the next render
  const anchorRef = useRef<{ r: number; c: number } | null>(null);
  const setAnchor = (a: { r: number; c: number } | null) => {
    anchorRef.current = a;
  };
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; initial?: string } | null>(null);
  const [modal, setModal] = useState<{ r: number; c: number } | null>(null);
  const [bulk, setBulk] = useState(false);
  const [saveSql, setSaveSql] = useState<string[] | null>(null);
  const [table, setTable] = useState<TableStructure | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const newCounter = useRef(0);
  /** Mouse drag selecting cells or whole rows */
  const drag = useRef<"cells" | "rows" | null>(null);
  useEffect(() => {
    const up = () => (drag.current = null);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const origin = rs.columns.find((c) => c.origin)?.origin ?? null;
  useEffect(() => {
    if (!connId || !origin) return;
    let alive = true;
    api.getTableStructure(connId, origin.schema, origin.table).then(
      (t) => alive && setTable(t),
      () => alive && setTable(null),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, origin?.schema, origin?.table]);

  const target: EditTarget | string = useMemo(() => editTargetOf(kind, rs, table), [kind, rs, table]);
  const editable = typeof target !== "string";
  const colMap = editable ? target.colMap : rs.columns.map(() => null);
  const kinds: CellKind[] = useMemo(() => rs.columns.map((c, i) => cellKind(c.typeName, colMap[i])), [rs.columns, colMap]);
  const numeric = useMemo(() => kinds.map((k) => k === "number"), [kinds]);
  const tsUnits: (TsUnit | null)[] = useMemo(
    () =>
      rs.columns.map((c, i) =>
        kinds[i] === "number" ? unixTsColumn(c.name, c.typeName, colMap[i], rs.rows.slice(0, 500).map((row) => row[i])) : null,
      ),
    [rs.columns, rs.rows, kinds, colMap],
  );
  const tsTip = useTsTip();
  const colEditable = (c: number) => editable && !!colMap[c] && kinds[c] !== "binary";

  // with a LIMIT or the Max rows cap only part of the data is loaded: sort in the database
  const sortOnServer = useMemo(() => {
    const q = connId ? exportableQuery(ran.base, kind) : null;
    return !!q && (!!q.limit || rs.truncated || ran.sort.length > 0 || filtersActive(ran.filters));
  }, [connId, ran, kind, rs.truncated]);
  const order = useMemo(() => (sortOnServer ? rs.rows.map((_, i) => i) : sortIndexes(rs.rows, sort, numeric)), [sortOnServer, rs.rows, sort, numeric]);
  const display: DisplayRow[] = useMemo(
    () => [...order.map((i) => ({ key: `e${i}`, existing: i })), ...pending.added.map((a) => ({ key: a.key, existing: null }))],
    [order, pending.added],
  );

  const valueAt = useCallback(
    (row: DisplayRow, c: number): Cell | undefined => {
      if (row.existing === null) return pending.added.find((a) => a.key === row.key)?.values[c];
      const changed = pending.changed[row.key];
      return changed && c in changed ? changed[c] : rs.rows[row.existing][c];
    },
    [pending, rs.rows],
  );
  const isChanged = (row: DisplayRow, c: number) => row.existing !== null && !!pending.changed[row.key] && c in pending.changed[row.key];

  const pages = Math.max(1, Math.ceil(display.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const offset = safePage * pageSize;
  const rows = useMemo(() => display.slice(offset, offset + pageSize), [display, offset, pageSize]);

  const autoWidths = useMemo(() => rs.columns.map((_, ci) => fitWidth(rs, ci, 60, 420)), [rs]);
  // widths set by dragging a header edge
  const [custom, setCustom] = useState<Record<number, number>>({});
  const widths = autoWidths.map((w, i) => custom[i] ?? w);

  // the click that ends a drag must not sort
  const resized = useRef(false);
  const startResize = (e: React.MouseEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    resized.current = true;
    const x0 = e.clientX;
    const w0 = widths[col];
    const onMove = (ev: MouseEvent) => setCustom((c) => ({ ...c, [col]: Math.max(MIN_COL_W, w0 + ev.clientX - x0) }));
    const onUp = () => {
      setTimeout(() => (resized.current = false));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
  };
  /** Wide enough for the longest value (within reason). */
  const fitColumn = (col: number) => setCustom((c) => ({ ...c, [col]: fitWidth(rs, col, 400, 1200) }));
  const totalW = GUTTER_W + widths.reduce((a, b) => a + b, 0);

  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 12 });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [safePage, pageSize]);

  const counts = pendingCount(pending);
  const hasChanges = counts.updated + counts.added + counts.deleted > 0;

  /** Sets several cells at once, skipping read-only columns. */
  const setValues = useCallback(
    (cells: { r: number; c: number }[], v: Cell | undefined | ((old: Cell | undefined) => Cell | undefined)) => {
      setPending((p) => {
        const next: PendingEdits = { changed: { ...p.changed }, added: p.added.map((a) => ({ ...a, values: [...a.values] })), deleted: p.deleted };
        for (const { r, c } of cells) {
          const row = display[r];
          if (!row || !colEditable(c)) continue;
          const old = row.existing === null ? next.added.find((a) => a.key === row.key)?.values[c] : (next.changed[row.key]?.[c] ?? rs.rows[row.existing][c]);
          const val = typeof v === "function" ? v(old) : v;
          if (row.existing === null) {
            const a = next.added.find((x) => x.key === row.key);
            if (a) a.values[c] = val;
          } else {
            if (val === undefined) continue; // DEFAULT only exists for new rows
            const orig = rs.rows[row.existing][c];
            const cols = { ...(next.changed[row.key] ?? {}) };
            if (val === orig) delete cols[c];
            else cols[c] = val;
            if (Object.keys(cols).length) next.changed[row.key] = cols;
            else delete next.changed[row.key];
          }
        }
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [display, rs.rows, editable, colMap, kinds],
  );

  const selectedCells = useCallback(() => [...selection].map((id) => id.split(":").map(Number)).map(([r, c]) => ({ r, c })), [selection]);
  const selectedRows = useCallback(() => [...new Set(selectedCells().map((x) => x.r))].sort((a, b) => a - b), [selectedCells]);

  // read by the export wizard
  useEffect(() => {
    const sel = selectedRows()
      .map((r) => display[r]?.existing)
      .filter((i): i is number => i !== null && i !== undefined);
    gridViews.set(tabId, { rs, order, selected: sel });
  }, [tabId, rs, order, display, selectedRows]);
  useEffect(() => () => void gridViews.delete(tabId), [tabId]);

  const addRow = (values?: (Cell | undefined)[]) => {
    const key = `n${newCounter.current++}`;
    setPending((p) => ({ ...p, added: [...p.added, { key, values: values ?? rs.columns.map(() => undefined) }] }));
    // the new row is last: go to the last page and select it
    const r = display.length;
    setTimeout(() => {
      setPage(Math.floor(r / pageSize));
      const c = rs.columns.findIndex((_, i) => colEditable(i) && !colMap[i]?.autoIncrement);
      select(r, Math.max(0, c), false, false);
    });
  };

  const duplicateRows = (rowIdx: number[]) => {
    for (const r of rowIdx) {
      const row = display[r];
      // don't copy the PK so the database assigns one
      addRow(rs.columns.map((_, c) => (colMap[c]?.primaryKey || colMap[c]?.autoIncrement ? undefined : (valueAt(row, c) ?? undefined))));
    }
  };

  const deleteRows = (rowIdx: number[]) => {
    const keys = rowIdx.map((r) => display[r]).filter(Boolean);
    setPending((p) => {
      const newKeys = new Set(keys.filter((k) => k.existing === null).map((k) => k.key));
      const existing = keys.filter((k) => k.existing !== null).map((k) => k.key);
      const deleted = [...p.deleted];
      for (const k of existing) if (!deleted.includes(k)) deleted.push(k);
      return { ...p, added: p.added.filter((a) => !newKeys.has(a.key)), deleted };
    });
    clearSelection();
  };

  const revertRows = (rowIdx: number[]) => {
    const keys = new Set(rowIdx.map((r) => display[r]?.key));
    setPending((p) => {
      const changed = { ...p.changed };
      for (const k of keys) delete changed[k!];
      return { changed, added: p.added.filter((a) => !keys.has(a.key)), deleted: p.deleted.filter((k) => !keys.has(k)) };
    });
  };

  const clearSelection = () => {
    setSelection(new Set());
    setActive(null);
    setAnchor(null);
  };

  /** Click: one cell. Shift: range from the anchor. Ctrl: toggle a cell. */
  const select = (r: number, c: number, shift: boolean, ctrl: boolean) => {
    const anchor = anchorRef.current;
    if (shift && anchor) {
      const next = new Set<string>();
      for (let i = Math.min(anchor.r, r); i <= Math.max(anchor.r, r); i++)
        for (let j = Math.min(anchor.c, c); j <= Math.max(anchor.c, c); j++) next.add(cellId(i, j));
      setSelection(next);
    } else if (ctrl) {
      setSelection((s) => {
        const next = new Set(s);
        if (next.has(cellId(r, c))) next.delete(cellId(r, c));
        else next.add(cellId(r, c));
        return next;
      });
      setAnchor({ r, c });
    } else {
      setSelection(new Set([cellId(r, c)]));
      setAnchor({ r, c });
    }
    setActive({ r, c });
  };

  const selectRows = (r: number, shift: boolean, ctrl: boolean) => {
    const anchor = anchorRef.current;
    const from = shift && anchor ? Math.min(anchor.r, r) : r;
    const to = shift && anchor ? Math.max(anchor.r, r) : r;
    setSelection((s) => {
      const next = ctrl ? new Set(s) : new Set<string>();
      for (let i = from; i <= to; i++) for (let c = 0; c < rs.columns.length; c++) next.add(cellId(i, c));
      return next;
    });
    if (!shift) setAnchor({ r, c: 0 });
    setActive({ r, c: 0 });
  };

  const selectColumn = (c: number) => {
    const next = new Set<string>();
    for (let r = 0; r < display.length; r++) next.add(cellId(r, c));
    setSelection(next);
    setAnchor({ r: 0, c });
    setActive({ r: 0, c });
  };

  const fullRowsSelected = () => {
    const rowsSel = selectedRows();
    return rowsSel.length > 0 && rowsSel.every((r) => rs.columns.every((_, c) => selection.has(cellId(r, c))));
  };

  /** Targets of an edit: the whole selection if it contains this cell, else just this cell. */
  const targetsFor = (r: number, c: number) =>
    selection.size > 1 && selection.has(cellId(r, c)) ? selectedCells().filter((x) => colEditable(x.c)) : [{ r, c }];
  const multiCount = (r: number, c: number) => (selection.size > 1 && selection.has(cellId(r, c)) ? targetsFor(r, c).length : 1);

  const startEdit = (r: number, c: number, initial?: string) => {
    if (!colEditable(c)) return;
    const row = display[r];
    if (row.existing !== null && pending.deleted.includes(row.key)) return;
    const k = kinds[c];
    const v = valueAt(row, c);
    if (k === "bool") {
      // all selected bool cells get the inverse of this one
      const next = v === null || v === undefined ? "1" : isTruthy(v) ? "0" : "1";
      setValues(targetsFor(r, c).filter((x) => kinds[x.c] === "bool"), next);
      return;
    }
    if (k === "json" || (typeof v === "string" && (v.includes("\n") || v.length > 160))) {
      setModal({ r, c });
      return;
    }
    setEditing({ r, c, initial });
  };

  const commitEdit = (v: Cell | undefined, move?: "down" | "right") => {
    if (!editing) return;
    const { r, c } = editing;
    const targets = targetsFor(r, c);
    setValues(targets, v);
    setEditing(null);
    // keep the selection after a multi-cell edit
    if (targets.length === 1) {
      if (move === "down" && r + 1 < display.length) select(r + 1, c, false, false);
      if (move === "right" && c + 1 < rs.columns.length) select(r, c + 1, false, false);
    }
    scrollRef.current?.focus();
  };

  const copySelection = () => {
    const cells = selectedCells();
    if (!cells.length) return;
    const rowsIdx = [...new Set(cells.map((x) => x.r))].sort((a, b) => a - b);
    const colsIdx = [...new Set(cells.map((x) => x.c))].sort((a, b) => a - b);
    const text = rowsIdx
      .map((r) => colsIdx.map((c) => (selection.has(cellId(r, c)) ? (valueAt(display[r], c) ?? "") : "")).map((v) => v ?? "NULL").join("\t"))
      .join("\n");
    void navigator.clipboard.writeText(text);
  };

  const paste = async () => {
    if (!editable || !active) return;
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const grid = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    const conv = (v: string): Cell => (v === "NULL" ? null : v);
    if (grid.length === 1 && grid[0].length === 1 && selection.size > 1) {
      setValues(selectedCells(), conv(grid[0][0]));
      return;
    }
    const cells: { r: number; c: number; v: Cell }[] = [];
    grid.forEach((line, i) => line.forEach((v, j) => cells.push({ r: active.r + i, c: active.c + j, v: conv(v) })));
    for (const x of cells) if (x.r < display.length && x.c < rs.columns.length) setValues([{ r: x.r, c: x.c }], x.v);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || modal) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (hasChanges && editable) setSaveSql(buildDml(target as EditTarget, rs, pending));
      return;
    }
    if (ctrl && e.key.toLowerCase() === "c") return void (e.preventDefault(), copySelection());
    if (ctrl && e.key.toLowerCase() === "v") return void (e.preventDefault(), paste());
    if (ctrl && e.key.toLowerCase() === "a") {
      e.preventDefault();
      const all = new Set<string>();
      display.forEach((_, r) => rs.columns.forEach((_, c) => all.add(cellId(r, c))));
      setSelection(all);
      return;
    }
    if (!active) return;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      const r = Math.max(0, Math.min(display.length - 1, active.r + dr));
      const c = Math.max(0, Math.min(rs.columns.length - 1, active.c + dc));
      if (Math.floor(r / pageSize) !== safePage) setPage(Math.floor(r / pageSize));
      select(r, c, e.shiftKey, false);
      virt.scrollToIndex(r - Math.floor(r / pageSize) * pageSize);
    };
    if (e.key === "ArrowDown") return move(1, 0);
    if (e.key === "ArrowUp") return move(-1, 0);
    if (e.key === "ArrowRight") return move(0, 1);
    if (e.key === "ArrowLeft") return move(0, -1);
    if (e.key === "Enter" || e.key === "F2") return void (e.preventDefault(), startEdit(active.r, active.c));
    if (e.key === " " && kinds[active.c] === "bool") return void (e.preventDefault(), startEdit(active.r, active.c));
    // t/y/1 = true, f/n/0 = false for selected boolean cells
    if (kinds[active.c] === "bool" && !ctrl && /^[tyfn01]$/i.test(e.key) && colEditable(active.c)) {
      e.preventDefault();
      const on = /^[ty1]$/i.test(e.key);
      setValues(targetsFor(active.r, active.c).filter((x) => kinds[x.c] === "bool"), on ? "1" : "0");
      return;
    }
    if (e.key === "Delete" && fullRowsSelected()) return void (e.preventDefault(), deleteRows(selectedRows()));
    if (e.key === "Escape") return clearSelection();
    // typing starts editing, like Excel
    if (e.key.length === 1 && !ctrl && !e.altKey && ["text", "number", "uuid", "year"].includes(kinds[active.c])) {
      e.preventDefault();
      startEdit(active.r, active.c, e.key);
    }
  };

  const cellMenu = (e: React.MouseEvent, r: number, c: number) => {
    if (!selection.has(cellId(r, c))) select(r, c, false, false);
    const many = selection.size > 1 && selection.has(cellId(r, c));
    const cells = many ? selectedCells() : [{ r, c }];
    const rowsIdx = many ? selectedRows() : [r];
    const anyNullable = cells.some((x) => colEditable(x.c) && colMap[x.c]?.nullable);
    const anyNew = cells.some((x) => display[x.r]?.existing === null);
    const n = cells.length;
    const items: MenuEntry[] = [
      { label: colEditable(c) ? "View / edit value…" : "View value…", icon: <PencilLine />, onClick: () => setModal({ r, c }) },
    ];
    const cellValue = display[r] ? valueAt(display[r], c) : undefined;
    if (filterable && display[r]?.existing !== null && cellValue !== undefined) {
      const name = rs.columns[c].name;
      const short = cellValue === null ? "NULL" : cellValue.length > 24 ? `${cellValue.slice(0, 24)}…` : cellValue;
      const ordered = kinds[c] === "number" || kinds[c] === "date" || kinds[c] === "datetime" || kinds[c] === "time" || kinds[c] === "year";
      const anchor = new DOMRect(e.clientX, e.clientY, 0, 0);
      items.push(
        "sep",
        {
          label: cellValue === null ? `Filter: ${name} is null` : `Filter: ${name} = ${short}`,
          icon: <Filter />,
          shortcut: "Alt+Click",
          onClick: () => quickFilter(c, "eq", cellValue),
        },
        {
          label: "Filter",
          icon: <Filter />,
          children: [
            ...(cellValue !== null
              ? [
                  { label: `${name} ≠ ${short}`, onClick: () => quickFilter(c, "ne", cellValue) },
                  ...(ordered
                    ? [
                        { label: `${name} > ${short}`, onClick: () => quickFilter(c, "gt", cellValue) },
                        { label: `${name} < ${short}`, onClick: () => quickFilter(c, "lt", cellValue) },
                      ]
                    : []),
                ]
              : []),
            { label: `${name} is null`, onClick: () => quickFilter(c, "null", null) },
            { label: `${name} is not null`, onClick: () => quickFilter(c, "notnull", null) },
            "sep",
            { label: "Filter by column…", icon: <Filter />, onClick: () => openFilter(c, anchor) },
          ],
        },
      );
      if (filtersActive(filters)) items.push({ label: "Clear filters", icon: <FilterX />, onClick: () => applyFilters({ ...filters, items: [], where: "" }) });
    }
    if (editable) {
      items.push(
        { label: n > 1 ? `Set value for ${n} cells…` : "Set value…", icon: <PencilLine />, onClick: () => setBulk(true), disabled: !cells.some((x) => colEditable(x.c)) },
        { label: n > 1 ? `Set NULL (${n} cells)` : "Set NULL", icon: <Eraser />, disabled: !anyNullable, onClick: () => setValues(cells.filter((x) => colMap[x.c]?.nullable), null) },
      );
      if (anyNew) items.push({ label: "Set DEFAULT", onClick: () => setValues(cells.filter((x) => display[x.r]?.existing === null), undefined) });
    }
    items.push("sep", { label: "Copy", icon: <ClipboardCopy />, shortcut: `${MOD}+C`, onClick: copySelection });
    if (editable) items.push({ label: "Paste", icon: <ClipboardPaste />, shortcut: `${MOD}+V`, onClick: () => void paste() });
    if (editable) {
      items.push(
        "sep",
        { label: "Add row", icon: <Plus />, onClick: () => addRow() },
        { label: rowsIdx.length > 1 ? `Duplicate ${rowsIdx.length} rows` : "Duplicate row", icon: <Copy />, onClick: () => duplicateRows(rowsIdx) },
        { label: rowsIdx.length > 1 ? `Delete ${rowsIdx.length} rows` : "Delete row", icon: <Trash2 />, danger: true, onClick: () => deleteRows(rowsIdx) },
        { label: "Revert changes in selection", icon: <RotateCcw />, onClick: () => revertRows(rowsIdx) },
      );
    }
    items.push("sep", { label: "Select column", onClick: () => selectColumn(c) }, { label: "Select row", onClick: () => selectRows(r, false, false) });
    useStore.getState().openContextMenu(e, items);
  };

  const headerMenu = (e: React.MouseEvent, c: number) =>
    useStore.getState().openContextMenu(e, [
      { label: "Sort ascending", icon: <ArrowUp />, onClick: () => applySort([{ col: c, dir: "asc" }]) },
      { label: "Sort descending", icon: <ArrowDown />, onClick: () => applySort([{ col: c, dir: "desc" }]) },
      { label: "Clear sorting", disabled: !sort.length, onClick: () => applySort([]) },
      ...(filterable
        ? (["sep", { label: "Filter by column…", icon: <Filter />, onClick: () => openFilter(c, new DOMRect(e.clientX, e.clientY, 0, 0)) }] as MenuEntry[])
        : []),
      ...(filters?.items.some((f) => f.col === rs.columns[c].name)
        ? [{ label: "Remove filters on this column", icon: <FilterX />, onClick: () => applyFilters({ ...filters, items: filters.items.filter((f) => f.col !== rs.columns[c].name) }) }]
        : []),
      "sep",
      { label: "Fit width to content", icon: <MoveHorizontal />, onClick: () => fitColumn(c) },
      {
        label: "Reset column widths",
        disabled: Object.keys(custom).length === 0,
        onClick: () => setCustom({}),
      },
      "sep",
      { label: "Select column", onClick: () => selectColumn(c) },
      { label: "Copy column name", icon: <ClipboardCopy />, onClick: () => void navigator.clipboard.writeText(rs.columns[c].name) },
    ]);

  const colNames = useMemo(() => rs.columns.map((c) => c.name), [rs.columns]);

  /** Re-runs the base query with these filters and sort keys. */
  const rerun = async (filters: GridFilters | undefined, keys: SortKey[], what: string) => {
    if (!ran.base) return;
    const sql = viewQuery(ran.base, kind, filters, keys, colNames);
    if (!sql) return;
    if (hasChanges && !(await ask(`${what} re-runs the query and discards unsaved changes. Continue?`, { title: "Unsaved changes", kind: "warning" }))) return;
    void useStore.getState().runTab(tabId, sql, { serverSort: keys.length ? { base: ran.base, keys } : undefined, filters: filtersActive(filters) ? filters : undefined });
  };

  const applySort = async (keys: SortKey[]) => {
    if (sortOnServer && ran.base) return rerun(ran.filters, keys, "Sorting");
    setSort(keys);
    setPage(0);
    clearSelection();
  };

  const filterable = !!connId && !!exportableQuery(ran.base, kind);
  const filterCols: FilterColumn[] = useMemo(
    () => rs.columns.map((c, i) => ({ name: c.name, kind: kinds[i], typeName: colMap[i]?.columnType ?? c.typeName, ts: tsUnits[i], enumValues: colMap[i]?.enumValues ?? undefined })),
    [rs.columns, kinds, colMap, tsUnits],
  );
  const filters = ran.filters;

  const applyFilters = (next: GridFilters) => void rerun({ ...next, base: ran.base! }, sort, "Filtering");

  const newFilter = (c: number, op: FilterOp, extra: Partial<ColumnFilter> = {}): ColumnFilter => ({
    id: crypto.randomUUID(),
    col: rs.columns[c].name,
    origin: rs.columns[c].origin?.column,
    kind: kinds[c],
    typeName: rs.columns[c].typeName,
    ts: tsUnits[c],
    op,
    ...extra,
  });

  /** Adds a filter; one with the same column and operator is replaced. */
  const addFilter = (f: ColumnFilter) => {
    const items = filters?.items ?? [];
    const same = items.find((x) => x.id === f.id || (x.col === f.col && x.op === f.op));
    const next = same ? items.map((x) => (x === same ? { ...f, id: same.id } : x)) : [...items, f];
    applyFilters({ base: ran.base!, join: filters?.join ?? "and", where: filters?.where ?? "", items: next });
  };

  /** Quick filter from a cell value. */
  const quickFilter = (c: number, op: "eq" | "ne" | "gt" | "lt" | "null" | "notnull", value: Cell | undefined) => {
    if (value === undefined) return;
    if (value === null || op === "null" || op === "notnull") return addFilter(newFilter(c, value === null ? (op === "ne" || op === "notnull" ? "notnull" : "null") : op));
    if (kinds[c] === "bool" && (op === "eq" || op === "ne")) return addFilter(newFilter(c, isTruthy(value) === (op === "eq") ? "true" : "false"));
    addFilter(newFilter(c, op, { value }));
  };

  const openFilter = (c: number, anchor: DOMRect, preset?: ColumnFilter) => {
    const existing = preset ?? filters?.items.find((x) => x.col === rs.columns[c].name);
    const def: FilterOp = kinds[c] === "text" ? "contains" : kinds[c] === "bool" ? "true" : kinds[c] === "json" ? "contains" : kinds[c] === "binary" ? "notnull" : tsUnits[c] ? "gt" : "eq";
    setFilterPop({ col: c, filter: existing ?? newFilter(c, def), anchor, isNew: !existing });
  };

  const loadTop = useCallback(
    async (c: number): Promise<TopValue[]> => {
      const sql = ran.base && topValuesQuery(ran.base, kind, rs.columns[c].name, pgAsText(kind, { kind: kinds[c], typeName: rs.columns[c].typeName }));
      if (!sql || !connId) return [];
      const tab = useStore.getState().tabs.find((t) => t.id === tabId);
      const qid = crypto.randomUUID();
      // a big table may take too long to count: give up after a few seconds
      const timer = setTimeout(() => void api.cancelQuery(qid).catch(() => {}), 4000);
      try {
        const out = await api.runQuery(connId, qid, sql, 10, tab ? tabDatabase(tab) : undefined);
        const set = out.resultSets.find((x) => x.returnsRows);
        return (set?.rows ?? []).map((r) => ({ value: r[0], n: r[1] ?? "0" }));
      } finally {
        clearTimeout(timer);
      }
    },
    [ran.base, kind, rs.columns, kinds, connId, tabId],
  );
  const popLoadTop = useMemo(
    () => (filterPop && !["json", "binary"].includes(kinds[filterPop.col]) ? () => loadTop(filterPop.col) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterPop?.col, filterPop?.filter.id, loadTop],
  );

  /** Writes the filtered (and sorted) query into the editor and runs it from there. */
  const filtersToEditor = () => {
    const st = useStore.getState();
    const tab = st.tabs.find((t) => t.id === tabId);
    if (!tab || !ran.base) return;
    const sql = viewQuery(ran.base, kind, filters, sort, colNames);
    if (!sql) return;
    const base = ran.base.trim();
    const at = tab.sql.indexOf(base);
    const text = at >= 0 ? tab.sql.slice(0, at) + sql + (/;\s*$/.test(base) ? ";" : "") + tab.sql.slice(at + base.length) : `${tab.sql.trimEnd()}\n\n${sql};\n`;
    if (!setEditorText(tabId, text)) st.updateTab(tabId, { sql: text });
    // the editor has them now: not a filtered re-run, and nothing to restore
    st.patchRuntime(tabId, { filters: undefined, serverSort: undefined });
    void st.runTab(tabId, sql);
  };

  const generated = useMemo(() => {
    if (!filtersActive(filters) || !ran.base) return null;
    return filterCondition(kind, filters, canInject(kind, ran.base, filters));
  }, [filters, ran.base, kind]);
  const elapsed = useStore((s) => s.runtime[tabId]?.output?.elapsedMs);
  const filterStatus = `${rs.rows.length.toLocaleString()}${rs.truncated ? "+" : ""} rows${elapsed !== undefined ? ` · ${Math.round(elapsed)} ms` : ""}`;

  const toggleSort = (col: number, multi: boolean) => {
    const existing = sort.find((s) => s.col === col);
    const next: SortKey | null = !existing ? { col, dir: "asc" } : existing.dir === "asc" ? { col, dir: "desc" } : null;
    const rest = sort.filter((s) => s.col !== col);
    void applySort(!multi ? (next ? [next] : []) : !next ? rest : existing ? sort.map((s) => (s.col === col ? next : s)) : [...rest, next]);
  };

  const modalRow = modal ? display[modal.r] : null;

  return (
    <>
      {filterable && (
        <FilterBar
          filters={filters}
          columns={filterCols}
          generated={generated}
          status={filterStatus}
          onChange={applyFilters}
          onEdit={(f, anchor) => {
            const c = rs.columns.findIndex((x) => x.name === f.col);
            if (c >= 0) openFilter(c, anchor, f);
          }}
          onAdd={(c, anchor) => openFilter(c, anchor)}
          onToEditor={filtersToEditor}
          quote={(n) => ident(n, kind)}
        />
      )}
      {filterPop && (
        <FilterPopover
          key={`${filterPop.col}-${filterPop.filter.id}`}
          column={filterCols[filterPop.col]}
          initial={filterPop.filter}
          anchor={filterPop.anchor}
          isNew={filterPop.isNew}
          loadTop={popLoadTop}
          onApply={(f) => {
            setFilterPop(null);
            addFilter(f);
          }}
          onRemove={() => {
            setFilterPop(null);
            if (filters) applyFilters({ ...filters, items: filters.items.filter((x) => x.id !== filterPop.filter.id) });
          }}
          onClose={() => setFilterPop(null)}
        />
      )}
      <div className="mx-3 mb-1.5 flex min-h-7 items-center gap-3 text-[12px] text-fg-2">
        {!editable && (
          <span className="flex cursor-help items-center gap-1.5 text-muted" title={target}>
            <Lock size={12} /> {target.startsWith("Loading") ? target : "Read-only"}
          </span>
        )}
        {sort.length > 0 && (
          <span className="flex items-center gap-1.5">
            <ArrowUpDown size={13} className="text-accent" />
            Sorted by{" "}
            {sort.map((s, i) => (
              <span key={s.col}>
                {i > 0 && ", "}
                <b className="font-medium text-fg">{rs.columns[s.col].name}</b> {s.dir === "asc" ? "↑" : "↓"}
              </span>
            ))}
            {sortOnServer && <span className="text-muted">(in the database)</span>}
            <button onClick={() => void applySort([])} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent hover:bg-accent-soft">
              <X size={12} /> Clear
            </button>
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {hasChanges && (
            <>
              <span className="text-warn">
                {[counts.updated && `${counts.updated} changed`, counts.added && `${counts.added} new`, counts.deleted && `${counts.deleted} deleted`].filter(Boolean).join(" · ")}
              </span>
              <Button className="h-7" variant="ghost" onClick={() => setPending(emptyPending())}>
                <RotateCcw size={13} /> Revert
              </Button>
              <Button className="h-7" variant="primary" onClick={() => setSaveSql(buildDml(target as EditTarget, rs, pending))} title={`Review and save (${MOD}+S)`}>
                <Save size={13} /> Save
              </Button>
            </>
          )}
        </div>
      </div>

      <div ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown} className="mx-3 min-h-0 flex-1 overflow-auto rounded-md border border-line outline-none">
        <div style={{ width: totalW, minWidth: "100%" }}>
          <div className="sticky top-0 z-20 flex border-b border-line bg-raised" style={{ height: 52 }}>
            <div style={{ width: GUTTER_W }} className="sticky left-0 z-10 shrink-0 bg-raised" />
            {rs.columns.map((c, i) => {
              const si = sort.findIndex((s) => s.col === i);
              const s = sort[si];
              const filtered = !!filters?.items.some((f) => f.col === c.name);
              return (
                <div
                  key={i}
                  style={{ width: widths[i] }}
                  onClick={(e) => !resized.current && toggleSort(i, e.shiftKey)}
                  onContextMenu={(e) => headerMenu(e, i)}
                  title="Click to sort · Shift+click to add a sort column · drag the edge to resize · right-click for more"
                  className={cx("group relative flex shrink-0 cursor-pointer flex-col justify-center border-l border-line/60 px-3 select-none hover:bg-hover", s && "bg-accent-soft")}
                >
                  <span
                    title="Drag to resize · double-click to fit"
                    onMouseDown={(e) => startResize(e, i)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      fitColumn(i);
                    }}
                    className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize after:absolute after:inset-y-2 after:left-[3px] after:w-0.5 after:rounded-full hover:after:bg-accent"
                  />
                  <span className={cx("flex items-center gap-1 text-[13px] font-medium text-fg", numeric[i] && "justify-end")}>
                    {colMap[i]?.primaryKey && <span className="text-[10px] text-warn">PK</span>}
                    <span className="truncate" title={c.origin ? `${c.origin.table}.${c.origin.column}` : c.name}>
                      {c.name}
                    </span>
                    {filterable && (
                      <button
                        title={filtered ? "Filtered · click to edit the filter" : "Filter by this column"}
                        onClick={(e) => {
                          e.stopPropagation();
                          openFilter(i, e.currentTarget.getBoundingClientRect());
                        }}
                        className={cx(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-accent-soft",
                          filtered ? "text-accent" : "text-muted opacity-0 group-hover:opacity-100",
                        )}
                      >
                        <Filter size={12} fill={filtered ? "currentColor" : "none"} />
                      </button>
                    )}
                    {s && (
                      <span className="flex shrink-0 items-center text-accent">
                        {s.dir === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                        {sort.length > 1 && <span className="text-[10px]">{si + 1}</span>}
                      </span>
                    )}
                  </span>
                  <span className={cx("flex items-center gap-1 truncate text-[11px] text-muted", numeric[i] && "justify-end")}>
                    {c.typeName}
                    {c.fk && (
                      <span className="flex items-center gap-0.5 truncate text-accent" title={`Foreign key → ${c.fk.table}.${c.fk.column}`}>
                        <Link2 size={11} /> {c.fk.table}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((v) => {
              const row = rows[v.index];
              const r = offset + v.index;
              const isNew = row.existing === null;
              const isDeleted = !isNew && pending.deleted.includes(row.key);
              const isModified = !isNew && !!pending.changed[row.key];
              return (
                <div
                  key={row.key}
                  className={cx(
                    "absolute left-0 flex w-full border-b border-line/60 text-[13px]",
                    v.index % 2 === 1 && "bg-bg/25",
                    isNew && "bg-ok/[0.07]",
                    isDeleted && "bg-err/10 text-muted line-through",
                  )}
                  style={{ height: ROW_H, transform: `translateY(${v.start}px)` }}
                >
                  {/* row selector + row state */}
                  <div
                    style={{ width: GUTTER_W }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      scrollRef.current?.focus();
                      drag.current = "rows";
                      selectRows(r, e.shiftKey, e.ctrlKey || e.metaKey);
                    }}
                    onMouseEnter={() => drag.current === "rows" && selectRows(r, true, false)}
                    onContextMenu={(e) => cellMenu(e, r, 0)}
                    title={isNew ? "New row" : isDeleted ? "Will be deleted" : isModified ? "Modified" : "Select row"}
                    className="sticky left-0 z-10 flex shrink-0 cursor-pointer items-center justify-center bg-panel-2 hover:bg-hover"
                  >
                    <span
                      className={cx(
                        "h-4 w-1 rounded-full",
                        isNew && "bg-ok",
                        isDeleted && "bg-err",
                        isModified && !isDeleted && "bg-warn",
                        !isNew && !isDeleted && !isModified && "bg-line-strong",
                      )}
                    />
                  </div>
                  {rs.columns.map((col, ci) => {
                    const value = valueAt(row, ci);
                    const selected = selection.has(cellId(r, ci));
                    const isActive = active?.r === r && active.c === ci;
                    const changed = isChanged(row, ci);
                    const fk = col.fk;
                    const isEditing = editing?.r === r && editing.c === ci;
                    return (
                      <div
                        key={ci}
                        onMouseDown={(e) => {
                          if (e.button !== 0 || isEditing) return;
                          e.preventDefault(); // no text selection while dragging
                          if (e.altKey && filterable && row.existing !== null) return quickFilter(ci, "eq", value);
                          scrollRef.current?.focus();
                          drag.current = "cells";
                          select(r, ci, e.shiftKey, e.ctrlKey || e.metaKey);
                        }}
                        onMouseEnter={(e) => {
                          if (drag.current === "cells") select(r, ci, true, false);
                          else if (tsUnits[ci] && typeof value === "string" && !isEditing) tsTip.show(value, e.currentTarget, ci);
                        }}
                        onMouseLeave={tsTip.hide}
                        onDoubleClick={() => (colEditable(ci) ? startEdit(r, ci) : setModal({ r, c: ci }))}
                        onContextMenu={(e) => cellMenu(e, r, ci)}
                        title={
                          value === null
                            ? "NULL (no value)"
                            : value === undefined
                              ? "DEFAULT"
                              : value === ""
                                ? "Empty string"
                                : tsUnits[ci] && unixTsInfo(value)
                                  ? undefined
                                  : value
                        }
                        style={{ width: widths[ci] }}
                        className={cx(
                          "relative flex shrink-0 items-center gap-1 border-l border-transparent px-3",
                          isEditing ? "z-30 overflow-visible" : "truncate",
                          numeric[ci] && "justify-end tabular-nums",
                          changed && "bg-warn/15",
                          selected && "bg-accent-soft",
                          isActive && "outline outline-1 -outline-offset-1 outline-accent",
                        )}
                      >
                        {isEditing && multiCount(r, ci) > 1 && (
                          <span
                            className={cx(
                              "pointer-events-none absolute right-0 z-40 rounded bg-accent px-1.5 py-px text-[10.5px] font-medium text-white shadow",
                              v.index === 0 ? "-bottom-5" : "-top-5", // below on the first row so the header doesn't cover it
                            )}
                          >
                            → {multiCount(r, ci)} cells
                          </span>
                        )}
                        {isEditing ? (
                          <CellEditor
                            kind={kinds[ci]}
                            value={value ?? null}
                            initial={editing!.initial}
                            column={colMap[ci]}
                            typeName={col.typeName}
                            dbKind={kind}
                            unixTs={tsUnits[ci]}
                            onCommit={commitEdit}
                            onCancel={() => {
                              setEditing(null);
                              scrollRef.current?.focus();
                            }}
                          />
                        ) : (
                          <CellDisplay value={value} kind={kinds[ci]} />
                        )}
                        {fk && value !== null && value !== undefined && connId && !isEditing && (
                          <button
                            title={`Open ${fk.table} where ${fk.column} = ${value}`}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => followFk(connId, kind, fk, value, numeric[ci])}
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-accent opacity-60 hover:bg-accent-soft hover:opacity-100"
                          >
                            <ArrowUpRight size={14} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {tsTip.state && !editing && <TsTip value={tsTip.state.value} anchor={tsTip.state.el} editable={colEditable(tsTip.state.c)} />}
      <Pagination
        page={safePage}
        pages={pages}
        onPage={setPage}
        pageSize={pageSize}
        onPageSize={(n) => setSettings({ pageSize: n })}
        left={
          editable && (
            <Button className="h-8" onClick={() => addRow()} title="Add a new row (saved with Save)">
              <BetweenHorizontalEnd size={15} /> Add row
            </Button>
          )
        }
      />

      {modal && modalRow && (
        <ValueModal
          title={rs.columns[modal.c].name}
          kind={kinds[modal.c]}
          value={valueAt(modalRow, modal.c) ?? null}
          editable={colEditable(modal.c) && !pending.deleted.includes(modalRow.key)}
          nullable={!!colMap[modal.c]?.nullable}
          onClose={() => setModal(null)}
          onSave={(v) => {
            setValues(targetsFor(modal.r, modal.c), v);
            setModal(null);
          }}
        />
      )}

      {bulk && active && (
        <BulkSetDialog
          count={selectedCells().filter((x) => colEditable(x.c)).length}
          kind={kinds[active.c]}
          column={colMap[active.c]}
          typeName={rs.columns[active.c].typeName}
          dbKind={kind}
          onClose={() => setBulk(false)}
          onApply={(v) => {
            setValues(selectedCells().filter((x) => colEditable(x.c)), v);
            setBulk(false);
          }}
        />
      )}

      {saveSql && connId && (
        <SaveDialog
          statements={saveSql}
          connId={connId}
          production={isProduction(cfg)}
          onClose={() => setSaveSql(null)}
          onSaved={() => {
            setSaveSql(null);
            setPending(emptyPending());
            const rt = useStore.getState().runtime[tabId];
            if (rt?.lastSql) void useStore.getState().runTab(tabId, rt.lastSql, { serverSort: rt.serverSort, filters: rt.filters });
          }}
        />
      )}
    </>
  );
}


/** Delayed hover tip for Unix timestamp cells; clicks and scrolling hide it. */
function useTsTip() {
  const [state, setState] = useState<{ value: string; el: HTMLElement; c: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setState(null);
  }, []);
  const show = (value: string, el: HTMLElement, c: number) => {
    clearTimeout(timer.current);
    if (!unixTsInfo(value)) return setState(null);
    timer.current = window.setTimeout(() => setState({ value, el, c }), 350);
  };
  useEffect(() => {
    if (!state) return;
    window.addEventListener("mousedown", hide, true);
    window.addEventListener("wheel", hide, true);
    return () => {
      window.removeEventListener("mousedown", hide, true);
      window.removeEventListener("wheel", hide, true);
    };
  }, [state, hide]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { state, show, hide };
}

function TsTip({ value, anchor, editable }: { value: string; anchor: HTMLElement; editable: boolean }) {
  const info = unixTsInfo(value);
  if (!info) return null;
  const r = anchor.getBoundingClientRect();
  const W = 270;
  const H = editable ? 170 : 140;
  const below = r.bottom + 6 + H <= window.innerHeight;
  const [date, time] = info.local.split(" ");
  return createPortal(
    <div
      style={{ left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)), top: below ? r.bottom + 6 : Math.max(8, r.top - H - 6), width: W }}
      className="pointer-events-none fixed z-[80] animate-[tip-in_140ms_ease-out] rounded-xl border border-line-strong bg-raised p-3 shadow-2xl shadow-black/50"
    >
      <div className="flex items-center gap-2 text-[11.5px] text-muted">
        <Clock size={13} className="shrink-0 text-accent" />
        <span>Unix timestamp · {info.unit === "ms" ? "milliseconds" : "seconds"}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-[17px] font-semibold tabular-nums leading-none text-fg">{date}</span>
        <span className="text-[15px] tabular-nums leading-none text-fg-2">{time}</span>
      </div>
      <div className="mt-1 text-[11.5px] text-muted">{relativeTime(info.ms)}</div>
      <div className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        <span className="text-muted">Local</span>
        <span className="font-mono text-fg tabular-nums">
          {info.local} <span className="text-muted">{info.zone}</span>
        </span>
        <span className="text-muted">UTC</span>
        <span className="font-mono text-fg tabular-nums">{info.utc}</span>
      </div>
      {editable && <div className="mt-2.5 border-t border-line pt-2 text-[11px] text-muted">Double-click to pick a date</div>}
    </div>,
    document.body,
  );
}

/** Typed rendering: NULL badge, ✓/✗, colored JSON, enum badge, ↵ for newlines, swatch for #colors. */
export function CellDisplay({ value, kind }: { value: Cell | undefined; kind: CellKind }) {
  if (value === undefined) return <span className="text-[12px] text-muted/70 italic">DEFAULT</span>;
  if (value === null) {
    return (
      <span className="shrink-0 rounded border border-dashed border-muted/60 bg-muted/10 px-1.5 py-px font-mono text-[10.5px] leading-none font-semibold tracking-wider text-muted">
        NULL
      </span>
    );
  }
  if (value === "") return <span className="text-[12px] text-muted/60 italic">empty</span>;
  if (kind === "bool") {
    const on = isTruthy(value);
    return (
      <span className={cx("flex items-center gap-1 text-[12px] font-medium", on ? "text-ok" : "text-muted")}>
        <span className={cx("flex h-4 w-4 items-center justify-center rounded text-[10px]", on ? "bg-ok/20" : "bg-muted/15")}>{on ? "✓" : "✗"}</span>
        {on ? "true" : "false"}
      </span>
    );
  }
  if ((kind === "date" || kind === "datetime") && /^-?infinity$/i.test(value)) {
    const neg = value.startsWith("-");
    return (
      <span className="rounded bg-accent-soft px-1.5 py-px text-[12px] font-medium text-accent" title={neg ? "-infinity: earlier than any date" : "infinity: later than any date"}>
        {neg ? "−∞" : "+∞"} {value}
      </span>
    );
  }
  if (kind === "json") return <JsonInline text={value} />;
  if (kind === "enum" || kind === "set") {
    return (
      <span className="flex gap-1 truncate">
        {value.split(kind === "set" ? "," : "\u0000").map((v) => (
          <span key={v} className="rounded bg-accent-soft px-1.5 py-px text-[11.5px] text-accent">
            {v}
          </span>
        ))}
      </span>
    );
  }
  if (kind === "binary") return <span className="truncate font-mono text-[12px] text-muted">{value}</span>;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="h-3.5 w-3.5 shrink-0 rounded border border-line-strong" style={{ background: value }} />
        <span className="font-mono text-[12.5px]">{value}</span>
      </span>
    );
  }
  if (value.includes("\n")) return <span className="truncate">{value.replace(/\r?\n/g, " ↵ ")}</span>;
  return <span className="truncate">{value}</span>;
}

/** Compact colored JSON. */
function JsonInline({ text }: { text: string }) {
  const short = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  const parts = short.split(/("(?:[^"\\]|\\.)*"\s*:?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],])/g);
  return (
    <span className="truncate font-mono text-[12px]">
      {parts.map((p, i) => {
        if (!p) return null;
        if (/^".*"\s*:$/.test(p)) return <span key={i} className="text-[#6fd3ee]">{p}</span>;
        if (p.startsWith('"')) return <span key={i} className="text-[#f6a35b]">{p}</span>;
        if (/^(true|false)$/.test(p)) return <span key={i} className="text-[#c792ea]">{p}</span>;
        if (p === "null") return <span key={i} className="text-muted">{p}</span>;
        if (/^-?\d/.test(p)) return <span key={i} className="text-[#7fd88f]">{p}</span>;
        if (/^[{}[\],]$/.test(p)) return <span key={i} className="text-fg-2">{p}</span>;
        return <span key={i}>{p}</span>;
      })}
    </span>
  );
}


function SaveDialog({
  statements,
  connId,
  production,
  onClose,
  onSaved,
}: {
  statements: string[];
  connId: string;
  production: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const affected = await api.executeBatch(connId, statements);
      const missed = affected.filter((n) => n === 0).length;
      if (missed > 0) console.warn(`${missed} statement(s) affected no rows`);
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="Save changes" onClose={onClose} width={720}>
      <div className="space-y-3 px-5 py-4">
        {production && (
          <p className="rounded-md bg-err/15 px-3 py-2 text-[13px] font-medium text-err">This saves to a PRODUCTION database.</p>
        )}
        <p className="text-[13px] text-fg-2">
          {statements.length} statement{statements.length === 1 ? "" : "s"} will run in one transaction: either all succeed, or nothing is changed.
        </p>
        <pre className="selectable max-h-[45vh] overflow-auto rounded-md border border-line bg-bg/50 p-4 font-mono text-[12.5px] leading-relaxed text-fg">
          {statements.join("\n") || "-- no changes"}
        </pre>
        {error && <p className="selectable rounded-md bg-err/10 px-3 py-2 text-[13px] whitespace-pre-wrap text-err">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={production ? "danger" : "primary"} onClick={() => void save()} disabled={busy || statements.length === 0}>
            {busy ? <Spinner /> : <Save size={15} />} Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}


function Pagination({
  page,
  pages,
  onPage,
  pageSize,
  onPageSize,
  left,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
  pageSize: number;
  onPageSize: (n: number) => void;
  /** Content left of the pager (e.g. "Add row") */
  left?: React.ReactNode;
}) {
  const items = pageItems(page, pages);
  const btn = "flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-[13px]";
  return (
    <div className="flex h-14 shrink-0 items-center justify-end gap-1 px-3">
      <div className="mr-auto">{left}</div>
      <IconButton title="Previous page" className={cx(btn, "text-muted")} disabled={page === 0} onClick={() => onPage(page - 1)}>
        <ChevronLeft size={16} />
      </IconButton>
      {items.map((p, i) =>
        p === -1 ? (
          <span key={`e${i}`} className="px-1 text-muted">
            …
          </span>
        ) : (
          <button key={p} onClick={() => onPage(p)} className={cx(btn, p === page ? "bg-accent text-white" : "text-fg-2 hover:bg-hover")}>
            {p + 1}
          </button>
        ),
      )}
      <IconButton title="Next page" className={cx(btn, "text-muted")} disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        <ChevronRight size={16} />
      </IconButton>
      <select
        value={pageSize}
        onChange={(e) => {
          onPageSize(Number(e.target.value));
          onPage(0);
        }}
        className="ml-2 h-8 rounded-md border border-line-strong bg-panel px-2 text-[13px] text-fg-2 outline-none"
      >
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n} / page
          </option>
        ))}
      </select>
    </div>
  );
}

/** [0,1,2,3,4,-1,9]; -1 is "…" */
function pageItems(page: number, pages: number): number[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i);
  const set = new Set([0, pages - 1, page - 1, page, page + 1]);
  if (page < 4) [1, 2, 3, 4].forEach((p) => set.add(p));
  if (page > pages - 5) [pages - 5, pages - 4, pages - 3, pages - 2].forEach((p) => set.add(p));
  const sorted = [...set].filter((p) => p >= 0 && p < pages).sort((a, b) => a - b);
  const out: number[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(-1);
    out.push(p);
  });
  return out;
}
