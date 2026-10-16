// Injected before the app loads: a fake Tauri backend with demo data, so screenshots never show
// real connections. Runs in the page (plain JS, no imports).
(() => {
  const CONN = "demo-shop";
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;

  const connections = [
    { id: CONN, name: "Shop", kind: "postgres", host: "localhost", port: 5432, user: "app", database: "shop", ssl: "prefer", savePassword: true, color: "blue", environment: "dev", projectId: null },
    { id: "demo-analytics", name: "Analytics", kind: "mysql", host: "localhost", port: 3306, user: "report", database: "analytics", ssl: "prefer", savePassword: true, color: "purple", environment: "staging", projectId: null },
  ];

  const stat = (rows) => ({ rows, dataBytes: rows * 180, indexBytes: rows * 40 });
  const col = (table, name, dataType, nullable = false) => ({ schema: "public", table, name, dataType, nullable });
  const schema = {
    schemas: [
      {
        name: "public",
        system: false,
        tables: ["customers", "orders", "order_items", "products", "sessions"],
        views: ["daily_revenue"],
        matViews: [],
        functions: ["refresh_stats"],
        procedures: [],
        triggers: [],
        tableStats: { customers: stat(48210), orders: stat(391204), order_items: stat(1203911), products: stat(2310), sessions: stat(88120) },
      },
      {
        name: "billing",
        system: false,
        tables: ["invoices", "payments", "refunds"],
        views: [],
        matViews: [],
        functions: [],
        procedures: [],
        triggers: [],
        tableStats: { invoices: stat(120400), payments: stat(118022), refunds: stat(1290) },
      },
    ],
    columns: [
      col("customers", "id", "bigint"),
      col("customers", "email", "text"),
      col("customers", "country", "text"),
      col("customers", "created_at", "bigint"),
      col("customers", "last_login", "bigint", true),
      col("orders", "id", "bigint"),
      col("orders", "customer_id", "bigint"),
      col("orders", "total", "numeric"),
      col("orders", "status", "text"),
      col("orders", "created_at", "timestamptz"),
    ],
  };

  const people = [
    ["ana.petrovic@example.com", "RS"],
    ["marko.jovanovic@example.com", "RS"],
    ["lena.schmidt@example.com", "DE"],
    ["tom.baker@example.com", "GB"],
    ["sofia.rossi@example.com", "IT"],
    ["lucas.martin@example.com", "FR"],
    ["eva.novak@example.com", "SI"],
    ["noah.jensen@example.com", "DK"],
    ["mia.horvat@example.com", "HR"],
    ["jan.kowalski@example.com", "PL"],
    ["ivan.ilic@example.com", "RS"],
    ["clara.weber@example.com", "AT"],
  ];
  const meta = (name, typeName, table = "customers") => ({ name, typeName, origin: { schema: "public", table, column: name }, fk: null });
  const customers = {
    columns: [meta("id", "int8"), meta("email", "text"), meta("country", "text"), meta("created_at", "int8"), meta("last_login", "int8")],
    rows: people.map(([email, country], i) => [
      String(1041 + i * 7),
      email,
      country,
      String(now - (420 - i * 31) * day - i * 3671),
      String((now - i * 5400 - i * i * 977) * 1000),
    ]),
    returnsRows: true,
    rowsAffected: 0,
    truncated: false,
  };

  const structCol = (name, columnType, extra = {}) => ({
    name, columnType, nullable: false, default: null, primaryKey: false, autoIncrement: false,
    comment: null, collation: null, extra: null, enumValues: null, ...extra,
  });
  const customersStructure = {
    schema: "public",
    table: "customers",
    isView: false,
    columns: [
      structCol("id", "bigint", { primaryKey: true }),
      structCol("email", "text"),
      structCol("country", "text"),
      structCol("created_at", "bigint"),
      structCol("last_login", "bigint", { nullable: true }),
    ],
    indexes: [{ name: "customers_pkey", columns: ["id"], unique: true, primary: true, method: "btree", constraint: true }],
    foreignKeys: [],
    referencedBy: [],
    ddl: "",
    engine: null,
    rowEstimate: "48210",
    sizeBytes: "10485760",
    tableComment: null,
    collation: null,
  };

  const serverInfo =(database) => ({ database, user: "app", version: "16.4", versionFull: "PostgreSQL 16.4", host: "localhost", port: 5432, ssl: false });

  // Table Doctor demo: findings for the shop tables, one detailed table (orders)
  const MB = 1024 * 1024;
  const ev = (label, value) => ({ label, value });
  const f = (id, severity, title, detail, evidence, fix = null) => ({ id, severity, title, detail, evidence, fix });
  const fix = (label, sql, note, long) => ({ label, sql, note, long });
  const ORDERS = '"public"."orders"';
  const orderFindings = [
    f("dead-rows", "critical", "23% of rows are dead",
      "Updated and deleted rows stay in the table until VACUUM cleans them up. Scans read them anyway, so the table is slower and bigger than it needs to be.",
      [ev("Dead rows", "116,850"), ev("Live rows", "391,204"), ev("Last vacuum", "12 days ago")],
      fix("Vacuum", `VACUUM (ANALYZE) ${ORDERS};`, "Doesn't block reads or writes; can take a while on a big table.", true)),
    f("fk-no-index:orders_customer_id_fkey", "warning", "Foreign key orders_customer_id_fkey has no index",
      "Deleting or updating a row in customers makes PostgreSQL look for referencing rows here with a full table scan, and joins on (customer_id) can't use an index.",
      [ev("Columns", "customer_id"), ev("References", "customers"), ev("Rows", "391,204")],
      fix("Create index", `CREATE INDEX CONCURRENTLY "orders_customer_id_idx" ON ${ORDERS} ("customer_id");`, "Builds without blocking writes; takes longer than a plain CREATE INDEX. If it fails it leaves an invalid index to drop.", true)),
    f("duplicate-index:orders_status_idx2", "warning", "Duplicate index orders_status_idx2",
      "orders_status_idx2 indexes exactly the same columns as orders_status_idx. One of them is enough; the other only slows down writes and takes space.",
      [ev("Index", "orders_status_idx2 (status)"), ev("Covered by", "orders_status_idx (status)"), ev("Size", "8.6 MB")],
      fix("Drop index", 'DROP INDEX CONCURRENTLY "public"."orders_status_idx2";', "Runs without blocking writes.", false)),
    f("unused-index:orders_legacy_ref_idx", "warning", "Unused index orders_legacy_ref_idx",
      "No query has used this index, but every INSERT, UPDATE and DELETE still has to maintain it. Usage has been counted for 41 days (since the statistics reset). Scans on read replicas are not counted here — check them before dropping.",
      [ev("Index scans", "0"), ev("Size", "14.2 MB"), ev("Columns", "legacy_ref")],
      fix("Drop index", 'DROP INDEX CONCURRENTLY "public"."orders_legacy_ref_idx";', "Runs without blocking writes. Keep the definition in case it is needed again.", false)),
    f("float-money:discount", "info", "discount stores money as a float",
      "Floating point can't represent most decimal fractions exactly (0.1 + 0.2 ≠ 0.3), so sums and comparisons of amounts drift. numeric keeps exact decimals.",
      [ev("Column", "discount double precision")],
      fix("Change type", `ALTER TABLE ${ORDERS} ALTER COLUMN "discount" TYPE numeric(18, 4);`, "Rewrites the whole table and locks it (no reads or writes) until done. Check the precision first.", true)),
  ];
  const index = (name, columns, mb, scans, extra = {}) => ({ name, columns, bytes: Math.round(mb * MB), scans, primary: false, unique: false, valid: true, definition: `CREATE INDEX ${name} ON public.orders USING btree (${columns.join(", ")})`, ...extra });
  const ordersHealth = {
    score: 43,
    stats: {
      rows: 391204, tableBytes: 88 * MB, indexBytes: 41 * MB, toastBytes: 2 * MB,
      liveBytes: 61 * MB, deadBytes: 18 * MB, freeBytes: 9 * MB,
      liveRows: 391204, deadRows: 116850, deadPct: 23, seqScans: 18420, indexScans: 11210, seqScanPct: 62.2,
      analyzedSecsAgo: 9 * day, vacuumedSecsAgo: 12 * day, modifiedSinceAnalyze: 48210, engine: null, usageSecs: 41 * day,
    },
    indexes: [
      index("orders_pkey", ["id"], 8.6, 2841022, { primary: true, unique: true }),
      index("orders_created_at_idx", ["created_at"], 8.6, 410233),
      index("orders_status_idx", ["status"], 8.6, 1190),
      index("orders_status_idx2", ["status"], 8.6, 4),
      index("orders_legacy_ref_idx", ["legacy_ref"], 14.2, 0),
    ],
    findings: orderFindings,
    notes: [],
    columns: [
      { name: "id", dataType: "bigint" },
      { name: "customer_id", dataType: "bigint" },
      { name: "status", dataType: "text" },
      { name: "total", dataType: "numeric(12,2)" },
      { name: "discount", dataType: "double precision" },
      { name: "legacy_ref", dataType: "text" },
      { name: "created_at", dataType: "timestamp with time zone" },
    ],
  };
  const report = (table, rows, mb, findings) => ({ table, rows, bytes: Math.round(mb * MB), findings });
  const schemaHealth = {
    public: {
      tables: [
        report("orders", 391204, 131, orderFindings),
        report("order_items", 1203911, 214, [
          f("seq-scans", "critical", "94% of scans read the whole table",
            "Most queries on this table read every row instead of using an index. Look for frequent queries filtering or joining on columns without an index.",
            [ev("Sequential scans", "52,110"), ev("Index scans", "3,302"), ev("Rows read per scan", "1,203,911")]),
          f("fk-no-index:order_items_product_id_fkey", "warning", "Foreign key order_items_product_id_fkey has no index",
            "Deleting or updating a row in products makes PostgreSQL look for referencing rows here with a full table scan, and joins on (product_id) can't use an index.",
            [ev("Columns", "product_id"), ev("References", "products"), ev("Rows", "1,203,911")],
            fix("Create index", 'CREATE INDEX CONCURRENTLY "order_items_product_id_idx" ON "public"."order_items" ("product_id");', "Builds without blocking writes; takes longer than a plain CREATE INDEX. If it fails it leaves an invalid index to drop.", true)),
        ]),
        report("sessions", 88120, 46, [
          f("dead-rows", "critical", "41% of rows are dead",
            "Updated and deleted rows stay in the table until VACUUM cleans them up. Scans read them anyway, so the table is slower and bigger than it needs to be.",
            [ev("Dead rows", "61,240"), ev("Live rows", "88,120"), ev("Last vacuum", "never")],
            fix("Vacuum", 'VACUUM (ANALYZE) "public"."sessions";', "Doesn't block reads or writes; can take a while on a big table.", true)),
          f("no-primary-key", "warning", "No primary key",
            "Rows can't be identified reliably: logical replication can't send UPDATE/DELETE for this table, duplicates are possible and many tools (including the grid editor) can't edit rows safely.",
            [ev("Rows", "88,120")]),
        ]),
        report("customers", 48210, 12, [
          f("stale-stats", "warning", "Planner statistics are out of date", "Many rows changed since the last ANALYZE, so the planner works with old numbers.",
            [ev("Changed since analyze", "14,920"), ev("Rows", "48,210"), ev("Last analyze", "34 days ago")],
            fix("Analyze", 'ANALYZE "public"."customers";', "Reads a sample of the table; doesn't block reads or writes.", true)),
        ]),
        report("products", 2310, 1, []),
      ],
      notes: [],
    },
    billing: {
      tables: [
        report("invoices", 120400, 38, [
          f("unused-index:invoices_note_idx", "info", "Unused index invoices_note_idx",
            "No query has used this index, but every INSERT, UPDATE and DELETE still has to maintain it.",
            [ev("Index scans", "0"), ev("Size", "640 KB"), ev("Columns", "note")],
            fix("Drop index", 'DROP INDEX CONCURRENTLY "billing"."invoices_note_idx";', "Runs without blocking writes.", false)),
        ]),
        report("payments", 118022, 31, []),
        report("refunds", 1290, 0.4, []),
      ],
      notes: [],
    },
  };
  const statusStats = {
    source: "pg_stats", missing: false, rows: 391204, nullPct: 0, distinct: 4,
    common: [{ value: "paid", pct: 71.2 }, { value: "shipped", pct: 18.4 }, { value: "pending", pct: 8.6 }, { value: "cancelled", pct: 1.8 }],
    histogram: [], indexes: ["orders_status_idx", "orders_status_idx2"],
  };

  // Grid filters: most common values of a column (SELECT _v.col, count(*) … GROUP BY …)
  const topValues = {
    country: [["RS", "18210"], ["DE", "9120"], ["HR", "6022"], ["AT", "4410"], ["SI", "3310"], ["GB", "2950"], ["FR", "2210"], ["IT", "1104"], ["PL", "620"], ["DK", "254"]],
  };
  const topValuesResult = (sql) => {
    const col = (/_v\.\"?(\w+)\"?/.exec(sql) ?? [])[1] ?? "value";
    const rows = topValues[col] ?? [["(other)", "1"]];
    return {
      resultSets: [{ columns: [meta(col, "text"), { name: "n", typeName: "int8", origin: null, fk: null }], rows, returnsRows: true, rowsAffected: 0, truncated: false }],
      elapsedMs: 41,
    };
  };

  // Visual Explain: one query on orders, with and without ANALYZE
  const analyzedPlan = [{
    Plan: {
      "Node Type": "Sort", "Total Cost": 52115.5, "Plan Rows": 2100, "Actual Total Time": 431.6, "Actual Rows": 34120, "Actual Loops": 1,
      "Sort Key": ["o.created_at DESC"], "Sort Method": "external merge", "Sort Space Used": 2856, "Sort Space Type": "Disk",
      Plans: [{
        "Node Type": "Hash Join", "Join Type": "Inner", "Total Cost": 51960.1, "Plan Rows": 2100, "Actual Total Time": 352.9, "Actual Rows": 34120, "Actual Loops": 1,
        "Hash Cond": "(o.customer_id = c.id)",
        Plans: [
          { "Node Type": "Seq Scan", "Relation Name": "orders", Alias: "o", "Total Cost": 50310.0, "Plan Rows": 2100, "Actual Total Time": 301.2, "Actual Rows": 34120, "Actual Loops": 1,
            Filter: "(status = 'pending'::text)", "Rows Removed by Filter": 357084, "Shared Hit Blocks": 2210, "Shared Read Blocks": 9010 },
          { "Node Type": "Hash", "Total Cost": 941.1, "Plan Rows": 48210, "Actual Total Time": 19.8, "Actual Rows": 48210, "Actual Loops": 1,
            "Hash Buckets": 65536, "Hash Batches": 1, "Peak Memory Usage": 3012,
            Plans: [{ "Node Type": "Seq Scan", "Relation Name": "customers", Alias: "c", "Total Cost": 941.1, "Plan Rows": 48210, "Actual Total Time": 8.4, "Actual Rows": 48210, "Actual Loops": 1 }] },
        ],
      }],
    },
    "Planning Time": 0.41,
    "Execution Time": 436.2,
  }];
  const plainPlan = JSON.parse(JSON.stringify(analyzedPlan, (k, v) => (/^Actual|Rows Removed|Shared|Sort Method|Sort Space|Hash Batches|Hash Buckets|Peak Memory|Planning Time|Execution Time/.test(k) ? undefined : v)));
  const explainResult = (a) => {
    const plan = a.analyze ? analyzedPlan : plainPlan;
    return { text: JSON.stringify(plan, null, 2), json: JSON.stringify(plan), analyzed: !!a.analyze };
  };

  // Slow queries on orders
  const slow = (id, query, calls, totalMs, rows) => ({ id, query, sample: null, calls, totalMs, meanMs: totalMs / calls, rows });
  const tableQueries = {
    unavailable: null,
    hypopg: true,
    hypopgAvailable: false,
    notes: ["Statements are matched by the table name in their text."],
    queries: [
      slow("1", "SELECT o.id, o.total, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = $1 ORDER BY o.created_at DESC", 18420, 4212000, 628440),
      slow("2", "SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2", 412000, 1854000, 8240000),
      slow("4", "SELECT id, customer_id, total FROM orders WHERE total > $1 ORDER BY total DESC", 2880, 410112, 2880),
      slow("3", "UPDATE orders SET status = $1 WHERE id = $2", 96000, 61440, 96000),
    ],
    suggestions: [
      {
        columns: ["customer_id"],
        queryIds: ["2"],
        finding: f("suggest-index:customer_id", "warning", "Index on (customer_id) would help 1 slow query",
          "The plan reads the whole table and filters on customer_id. An index on these columns lets the database jump to the matching rows instead.",
          [ev("Columns", "customer_id"), ev("Queries", "1 · 412,000 calls"), ev("Total time", "30.9 min"), ev("Mean time", "4.5 ms"), ev("Table rows", "391,204")],
          fix("Create index", `CREATE INDEX CONCURRENTLY "orders_customer_id_idx" ON ${ORDERS} ("customer_id");`, "Builds without blocking writes; takes longer than a plain CREATE INDEX. If it fails it leaves an invalid index to drop.", true)),
      },
      {
        columns: ["total"],
        queryIds: ["4"],
        finding: f("suggest-index:total", "warning", "Index on (total) would help 1 slow query",
          "The plan reads the whole table and filters on total. An index on these columns lets the database jump to the matching rows instead.",
          [ev("Columns", "total"), ev("Queries", "1 · 2,880 calls"), ev("Total time", "6.8 min"), ev("Mean time", "142.4 ms"), ev("Table rows", "391,204")],
          fix("Create index", `CREATE INDEX CONCURRENTLY "orders_total_idx" ON ${ORDERS} ("total");`, "Builds without blocking writes; takes longer than a plain CREATE INDEX. If it fails it leaves an invalid index to drop.", true)),
      },
    ],
  };
  const whatIf = {
    index: 'CREATE INDEX ON "public"."orders" ("customer_id")',
    results: [{ queryId: "2", query: tableQueries.queries[1].query, beforeCost: 50310, afterCost: 12.4, beforeScan: "Seq Scan", afterScan: "Index Scan using the new index", usesIndex: true, error: null }],
  };

  const handlers = {
    list_connections: () => connections,
    list_projects: () => [],
    connect: () => serverInfo("shop"),
    open_database: (a) => serverInfo(a.database),
    disconnect: () => null,
    list_databases: () => [{ name: "shop", size: 412_000_000 }],
    get_schema: () => schema,
    get_table_structure: () => customersStructure,
    list_collations: () => [],
    list_known_hosts: () => [],
    run_query: (a) => (/group by/i.test(a.sql ?? "") ? topValuesResult(a.sql) : { resultSets: [customers], elapsedMs: 23 }),
    explain_query: explainResult,
    table_queries: () => tableQueries,
    what_if_index: () => whatIf,
    cancel_query: () => true,
    analyze_table: () => ordersHealth,
    analyze_schema: (a) => schemaHealth[a.schema] ?? { tables: [], notes: [] },
    column_stats: () => statusStats,
    "plugin:app|version": () => "0.1.7",
    "plugin:app|name": () => "DB Client",
    "plugin:dialog|ask": () => false,
    "plugin:dialog|confirm": () => false,
    "plugin:notification|is_permission_granted": () => false,
    "plugin:event|listen": () => 1,
    "plugin:event|unlisten": () => null,
  };

  let cb = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: () => ++cb,
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      const h = handlers[cmd];
      if (h) return h(args ?? {});
      if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:webview|")) return null;
      console.warn("[mock] unhandled", cmd);
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__DEMO__ = { CONN };
})();
