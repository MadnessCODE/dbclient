// Execution plans from EXPLAIN (FORMAT JSON) of PostgreSQL and MySQL as one tree: what each step
// costs (or took), how its row estimate held up, and what looks wrong.

export interface PlanNode {
  id: number;
  op: string;
  /** "on orders o", "using orders_pkey" */
  detail: string;
  /** Inclusive cost (planner units) */
  cost: number;
  selfCost: number;
  /** Estimated rows, over all loops */
  estRows: number | null;
  /** Actual rows over all loops (ANALYZE) */
  actualRows: number | null;
  loops: number | null;
  /** Inclusive / own time in ms (ANALYZE) */
  time: number | null;
  selfTime: number | null;
  /** Own share of the whole plan, 0..1 (time when analyzed, else cost) */
  share: number;
  /** One of the most expensive steps */
  hot: boolean;
  warnings: string[];
  /** Conditions, keys, sort method… */
  info: [string, string][];
  children: PlanNode[];
}

export interface Plan {
  root: PlanNode;
  analyzed: boolean;
  totalCost: number;
  planningMs: number | null;
  executionMs: number | null;
}

const BIG = 10_000;

const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v !== "" && isFinite(Number(v)) ? Number(v) : null);
const fmt = (n: number) => Math.round(n).toLocaleString();

export function parsePlan(json: string, kind: "postgres" | "mysql"): Plan | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const plan = kind === "postgres" ? pgPlan(data) : myPlan(data);
  if (!plan) return null;
  finish(plan);
  return plan;
}

/** Own cost/time, shares and the hottest steps. */
function finish(plan: Plan) {
  const all: PlanNode[] = [];
  const visit = (n: PlanNode) => {
    all.push(n);
    n.children.forEach(visit);
    const kids = n.children;
    n.selfCost = Math.max(0, n.cost - kids.reduce((a, c) => a + c.cost, 0));
    if (n.time != null) n.selfTime = Math.max(0, n.time - kids.reduce((a, c) => a + (c.time ?? 0), 0));
  };
  visit(plan.root);
  const byTime = plan.analyzed && plan.root.time != null && plan.root.time > 0;
  const total = byTime ? all.reduce((a, n) => a + (n.selfTime ?? 0), 0) : all.reduce((a, n) => a + n.selfCost, 0);
  for (const n of all) n.share = total > 0 ? (byTime ? (n.selfTime ?? 0) : n.selfCost) / total : 0;
  const ranked = [...all].sort((a, b) => b.share - a.share);
  ranked.slice(0, 3).forEach((n) => (n.hot = n.share >= 0.1));
}

function node(id: number, op: string, detail = ""): PlanNode {
  return { id, op, detail, cost: 0, selfCost: 0, estRows: null, actualRows: null, loops: null, time: null, selfTime: null, share: 0, hot: false, warnings: [], info: [], children: [] };
}

// ---------- PostgreSQL ----------

type Obj = Record<string, unknown>;

function pgPlan(data: unknown): Plan | null {
  const top = (Array.isArray(data) ? data[0] : data) as Obj | undefined;
  const root = top?.Plan as Obj | undefined;
  if (!root) return null;
  let id = 0;
  const analyzed = root["Actual Total Time"] != null;

  const conv = (p: Obj): PlanNode => {
    const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
    let op = s("Node Type") ?? "?";
    if (s("Join Type") && s("Join Type") !== "Inner") op += ` (${s("Join Type")})`;
    if (s("Strategy") && op === "Aggregate") op = `${s("Strategy") === "Hashed" ? "Hash" : s("Strategy") === "Sorted" ? "Group" : ""} Aggregate`.trim();
    const rel = s("Relation Name");
    const alias = s("Alias");
    const parts = [
      rel ? `on ${rel}${alias && alias !== rel ? ` ${alias}` : ""}` : s("CTE Name") ? `on ${s("CTE Name")}` : s("Function Name") ? `on ${s("Function Name")}()` : "",
      s("Index Name") ? `using ${s("Index Name")}` : "",
      s("Subplan Name") ?? "",
    ];
    const n = node(++id, op, parts.filter(Boolean).join(" "));
    n.cost = num(p["Total Cost"]) ?? 0;
    const loops = num(p["Actual Loops"]);
    const planRows = num(p["Plan Rows"]);
    n.estRows = planRows != null ? planRows * (analyzed && loops ? loops : 1) : null;
    if (analyzed && loops != null) {
      n.loops = loops;
      n.actualRows = (num(p["Actual Rows"]) ?? 0) * loops;
      n.time = (num(p["Actual Total Time"]) ?? 0) * loops;
    }
    for (const k of ["Index Cond", "Recheck Cond", "Hash Cond", "Merge Cond", "Join Filter", "Filter", "One-Time Filter"]) if (s(k)) n.info.push([k, s(k)!]);
    for (const k of ["Sort Key", "Group Key", "Presorted Key"]) if (Array.isArray(p[k])) n.info.push([k, (p[k] as string[]).join(", ")]);
    const removed = num(p["Rows Removed by Filter"]);
    if (removed) n.info.push(["Rows removed by filter", fmt(removed * (loops ?? 1))]);
    if (s("Sort Method")) n.info.push(["Sort", `${s("Sort Method")}, ${num(p["Sort Space Used"]) ?? "?"} kB ${s("Sort Space Type") ?? ""}`.trim()]);
    const batches = num(p["Hash Batches"]);
    if (batches != null) n.info.push(["Hash", `${num(p["Hash Buckets"]) ?? "?"} buckets, ${batches} batch${batches === 1 ? "" : "es"}, ${num(p["Peak Memory Usage"]) ?? "?"} kB`]);
    const hit = num(p["Shared Hit Blocks"]);
    const read = num(p["Shared Read Blocks"]);
    if (hit || read) n.info.push(["Buffers", `${fmt(hit ?? 0)} hit, ${fmt(read ?? 0)} read`]);

    n.children = Array.isArray(p.Plans) ? (p.Plans as Obj[]).map(conv) : [];

    // warnings
    if (op.startsWith("Seq Scan")) {
      const scanned = analyzed ? ((num(p["Actual Rows"]) ?? 0) + (removed ?? 0)) * (loops ?? 1) : planRows ?? 0;
      if (scanned >= BIG || (!analyzed && n.cost >= 2000)) {
        const hint = s("Filter") ? " An index on the filtered columns could avoid it." : "";
        n.warnings.push(`Reads the whole table${rel ? ` ${rel}` : ""}${scanned >= BIG ? ` (${fmt(scanned)} rows)` : ""}.${hint}`);
      }
    }
    if (analyzed && planRows != null && loops) {
      const est = planRows;
      const act = num(p["Actual Rows"]) ?? 0;
      const hi = Math.max(est, act);
      const lo = Math.max(1, Math.min(est, act));
      if (hi >= 100 && hi / lo >= 10) {
        n.warnings.push(`Estimated ${fmt(est)} rows, got ${fmt(act)} (${Math.round(hi / lo)}× off). Statistics may be stale: ANALYZE the table.`);
      }
    }
    if (s("Sort Space Type") === "Disk") n.warnings.push("The sort spilled to disk. More work_mem, or an index in this order, keeps it in memory.");
    if (batches != null && batches > 1) n.warnings.push(`The hash spilled to disk in ${batches} batches. More work_mem keeps it in memory.`);
    if (op.startsWith("Nested Loop") && n.children[0]) {
      const outer = n.children[0].actualRows ?? n.children[0].estRows ?? 0;
      if (outer >= BIG) n.warnings.push(`Nested loop over ${fmt(outer)} rows: the inner side runs once per row.`);
    }
    return n;
  };

  return {
    root: conv(root),
    analyzed,
    totalCost: num(root["Total Cost"]) ?? 0,
    planningMs: num(top?.["Planning Time"]),
    executionMs: num(top?.["Execution Time"]),
  };
}

// ---------- MySQL ----------

const ACCESS: Record<string, string> = {
  ALL: "Full table scan",
  index: "Full index scan",
  range: "Index range scan",
  ref: "Index lookup",
  eq_ref: "Unique index lookup",
  ref_or_null: "Index lookup (or NULL)",
  const: "Single row (constant)",
  system: "Single row",
  fulltext: "Full-text search",
  index_merge: "Index merge",
  unique_subquery: "Unique subquery lookup",
  index_subquery: "Subquery index lookup",
};

function myPlan(data: unknown): Plan | null {
  const qb = (data as Obj | null)?.query_block as Obj | undefined;
  if (!qb) return null;
  let id = 0;

  const tableNode = (t: Obj, inJoin: number): PlanNode => {
    const s = (k: string) => (typeof t[k] === "string" ? (t[k] as string) : undefined);
    const access = s("access_type") ?? "?";
    const n = node(++id, ACCESS[access] ?? access, [`on ${s("table_name") ?? "?"}`, s("key") ? `using ${s("key")}` : ""].filter(Boolean).join(" "));
    const ci = (t.cost_info ?? {}) as Obj;
    n.cost = (num(ci.read_cost) ?? 0) + (num(ci.eval_cost) ?? 0);
    n.estRows = num(t.rows_examined_per_scan);
    if (s("attached_condition")) n.info.push(["Condition", s("attached_condition")!]);
    if (Array.isArray(t.used_key_parts)) n.info.push(["Key parts", (t.used_key_parts as string[]).join(", ")]);
    const filtered = num(t.filtered);
    if (filtered != null && filtered < 100) n.info.push(["Filtered", `${filtered}% of rows kept`]);
    if (num(t.rows_produced_per_join) != null) n.info.push(["Rows produced", fmt(num(t.rows_produced_per_join)!)]);
    if (access === "ALL" && (n.estRows ?? 0) >= BIG) n.warnings.push(`Reads the whole table (${fmt(n.estRows!)} rows). An index on the filtered columns could avoid it.`);
    if (access === "ALL" && inJoin > 0) n.warnings.push("Joined without an index: this table is read once per row of the tables before it.");
    if (t.using_join_buffer) n.info.push(["Join buffer", String(t.using_join_buffer)]);
    const sub = t.materialized_from_subquery as Obj | undefined;
    if (sub?.query_block) n.children.push(block(sub.query_block as Obj, "Derived table"));
    return n;
  };

  const inner = (o: Obj): PlanNode[] => {
    const out: PlanNode[] = [];
    if (o.table) out.push(tableNode(o.table as Obj, 0));
    if (Array.isArray(o.nested_loop)) {
      const loop = node(++id, "Nested loop join");
      (o.nested_loop as Obj[]).forEach((x, i) => x.table && loop.children.push(tableNode(x.table as Obj, i)));
      out.push(loop);
    }
    const wrap = (key: string, label: (x: Obj) => string) => {
      const x = o[key] as Obj | undefined;
      if (!x) return;
      const n = node(++id, label(x));
      if (x.using_temporary_table) n.info.push(["Uses", "a temporary table"]);
      if (x.using_filesort) n.info.push(["Sort", "filesort (no index in this order)"]);
      n.children = inner(x);
      out.push(n);
    };
    wrap("ordering_operation", (x) => (x.using_filesort ? "Sort" : "Ordered by index"));
    wrap("grouping_operation", () => "Group");
    wrap("duplicates_removal", () => "Remove duplicates");
    wrap("windowing", () => "Window");
    const union = o.union_result as Obj | undefined;
    if (union) {
      const n = node(++id, "Union");
      for (const q of (union.query_specifications as Obj[]) ?? []) if (q.query_block) n.children.push(block(q.query_block as Obj, "Select"));
      out.push(n);
    }
    for (const k of ["attached_subqueries", "optimized_away_subqueries"]) {
      for (const q of (o[k] as Obj[]) ?? []) if (q.query_block) out.push(block(q.query_block as Obj, "Subquery"));
    }
    return out;
  };

  const block = (b: Obj, label: string): PlanNode => {
    const n = node(++id, `${label}${b.select_id != null ? ` #${b.select_id}` : ""}`);
    n.children = inner(b);
    return n;
  };

  const root = block(qb, "Query");
  // tables carry their own cost; make every node's cost inclusive
  const incl = (x: PlanNode): number => (x.cost += x.children.reduce((a, c) => a + incl(c), 0));
  incl(root);
  const qc = num(((qb.cost_info ?? {}) as Obj).query_cost);
  return { root, analyzed: false, totalCost: qc ?? root.cost, planningMs: null, executionMs: null };
}
