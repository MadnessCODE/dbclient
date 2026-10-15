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
    run_query: () => ({ resultSets: [customers], elapsedMs: 23 }),
    explain_query: () => "Seq Scan on customers  (cost=0.00..1043.10 rows=48210 width=64)",
    cancel_query: () => true,
    "plugin:app|version": () => "0.1.5",
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
