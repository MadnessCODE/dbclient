// Screenshot scenarios per release, run by run.mjs. Each one drives the app on demo data and
// saves shots to site/releases/<version>/<name>.png; CHANGELOG.md links them.

const SQL = `-- Customers who signed up this year
SELECT id, email, country, created_at, last_login
FROM customers
WHERE created_at >= extract(epoch FROM date_trunc('year', now()))
ORDER BY created_at DESC
LIMIT 100;`;

const fav = (id, name, categoryId, sql) => ({ id, name, categoryId, sql, connId: "demo-shop", createdAt: 0, updatedAt: 0 });

const FAVORITES = [
  fav("f1", "Revenue by day, last 30 days", "c-rep", "SELECT date_trunc('day', created_at) AS day, sum(total) AS revenue\nFROM orders\nWHERE created_at > now() - interval '30 days'\nGROUP BY 1\nORDER BY 1"),
  fav("f2", "Top customers by spend", "c-rep", "SELECT c.email, sum(o.total) AS spent\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nGROUP BY c.email\nORDER BY spent DESC\nLIMIT 20"),
  fav("f3", "Orders by status", "c-rep", "SELECT status, count(*)\nFROM orders\nGROUP BY status\nORDER BY 2 DESC"),
  fav("f4", "Table sizes", "c-mnt", "SELECT relname, pg_size_pretty(pg_total_relation_size(relid))\nFROM pg_catalog.pg_statio_user_tables\nORDER BY pg_total_relation_size(relid) DESC"),
  fav("f5", "Long-running queries", "c-mnt", "SELECT pid, now() - query_start AS runtime, query\nFROM pg_stat_activity\nWHERE state = 'active'\nORDER BY runtime DESC"),
  fav("f6", "Find customer by email", "c-sup", "SELECT *\nFROM customers\nWHERE email ILIKE '%' || :email || '%'"),
  fav("f7", "Recent orders of a customer", "c-sup", "SELECT id, total, status, created_at\nFROM orders\nWHERE customer_id = :id\nORDER BY created_at DESC\nLIMIT 50"),
];

/** Demo workspace: one tab on the Shop connection, favorites in three categories. */
const seed = `
  localStorage.setItem("favorites:lastCategory", "c-rep");
  const { useStore } = await import("/src/store.ts");
  useStore.setState({
    tabs: [
      { id: "t1", title: "new customers.sql", sql: ${JSON.stringify(SQL)}, connId: "demo-shop" },
      { id: "t2", title: "orders.sql", sql: "SELECT * FROM orders LIMIT 100;", connId: "demo-shop" },
    ],
    activeTabId: "t1",
    untitledCounter: 0,
    history: [],
    favorites: ${JSON.stringify(FAVORITES)},
    favoriteCategories: [{ id: "c-rep", name: "Reports" }, { id: "c-mnt", name: "Maintenance" }, { id: "c-sup", name: "Support" }],
    selectedConnId: "demo-shop",
  });
  await useStore.getState().loadConnections();
  useStore.getState().setActiveTab("t1");
  await useStore.getState().connectTo("demo-shop");
  for (let i = 0; i < 100 && !document.querySelector(".monaco-editor"); i++) await new Promise((r) => setTimeout(r, 100));
`;

/** Runs the demo query and returns the created_at cell of the third row. */
async function runAndFindTimestampCell(s) {
  await s.js(`const { useStore } = await import("/src/store.ts"); await useStore.getState().runTab("t1");`);
  await s.sleep(900);
  return s.js(`
    const cells = [...document.querySelectorAll("main div, main span")].filter((d) => d.children.length === 0 && /^[0-9]{10}$/.test(d.textContent.trim()));
    const r = cells[2].getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };`);
}

/** The left panel (connections tree). */
const leftPanel = (s) =>
  s.js(`
    const r = document.querySelector("main").previousElementSibling.previousElementSibling.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };`);

/** Area around a set of boxes, padded. */
function around(boxes, pad = 16) {
  const x = Math.min(...boxes.map((b) => b.x)) - pad;
  const y = Math.min(...boxes.map((b) => b.y)) - pad;
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  return { x, y, width: right - x, height: bottom - y };
}

/** Editor panel (toolbar + Monaco) of the active tab. */
async function editorBox(s) {
  const r = await s.rect("main > div > div.rounded-lg");
  // include the tab bar above it
  return { ...r, y: r.y - 48, height: r.height + 48 };
}

/** Viewport position of a line/column in Monaco. */
async function editorPoint(s, lineNumber, column) {
  return s.js(`
    const { monaco } = await import("/src/lib/monaco.ts");
    const ed = monaco.editor.getEditors()[0];
    const p = ed.getScrolledVisiblePosition({ lineNumber: ${lineNumber}, column: ${column} });
    const r = ed.getDomNode().getBoundingClientRect();
    return { x: r.x + p.left, y: r.y + p.top + p.height / 2 };`);
}

async function selectLines(s, from, to) {
  await s.js(`
    const { monaco } = await import("/src/lib/monaco.ts");
    const ed = monaco.editor.getEditors()[0];
    ed.setSelection(new monaco.Range(${from}, 1, ${to}, ed.getModel().getLineMaxColumn(${to})));
    ed.focus();`);
}

async function openContextMenuOnSelection(s) {
  await selectLines(s, 2, 6);
  const p = await editorPoint(s, 3, 12);
  await s.click(p.x, p.y, "right");
  await s.sleep(200);
  const item = await s.rect("[data-context-menu] button", "Add to favorites");
  await s.hover(item.x + 40, item.y + item.height / 2);
  return item;
}

/** Opens Table Doctor for public.orders and waits for its analysis. */
async function openOrdersDoctor(s) {
  await s.js(`
    const { openDoctor, useDoctor } = await import("/src/lib/doctor.ts");
    const { useStore } = await import("/src/store.ts");
    openDoctor("demo-shop", "public", "orders");
    for (let i = 0; i < 50 && !useDoctor.getState().byTab[useStore.getState().activeTabId]?.health; i++) await new Promise((r) => setTimeout(r, 100));`);
  await s.sleep(500);
}

/** Runs the demo query with two grid filters: country in RS/HR/SI and created in the last 30 days. */
async function filteredGrid(s) {
  await s.js(`
    const { useStore } = await import("/src/store.ts");
    const { viewQuery } = await import("/src/lib/filter.ts");
    await useStore.getState().runTab("t1");
    const base = useStore.getState().runtime.t1.lastSql;
    const since = String(Math.floor(Date.now() / 1000) - 30 * 86400);
    const filters = {
      base,
      join: "and",
      where: "",
      items: [
        { id: "f1", col: "country", origin: "country", kind: "text", typeName: "text", op: "in", values: ["RS", "HR", "SI"] },
        { id: "f2", col: "created_at", origin: "created_at", kind: "number", typeName: "int8", ts: "s", op: "gt", value: since },
      ],
    };
    const sql = viewQuery(base, "postgres", filters, [], ["id", "email", "country", "created_at", "last_login"]);
    await useStore.getState().runTab("t1", sql, { filters });`);
  await s.sleep(800);
}

/** Main area (tab bar and the active tab). */
const mainBox = (s) => s.rect("main");

export const scenarios = {
  "0.1.5": [
    {
      name: "favorites-picker",
      async run(s) {
        await s.load(seed);
        const btn = await s.rect("button", "Favorites");
        await s.click(btn.x + btn.width / 2, btn.y + btn.height / 2);
        await s.sleep(300);
        const reports = await s.rect("div.fixed.z-40 div.cursor-pointer", "Reports");
        await s.click(reports.x + 60, reports.y + reports.height / 2);
        const row = await s.rect("div.fixed.z-40 li.cursor-pointer", "Top customers");
        await s.hover(row.x + 120, row.y + row.height / 2);
        await s.sleep(250);
        const panel = await s.rect("div.fixed.z-40");
        const editor = await editorBox(s);
        await s.shot("favorites-picker", around([{ ...editor, height: 300 }, panel], 14));
      },
    },
    {
      name: "favorites-add",
      async run(s) {
        await s.load(seed);
        const item = await openContextMenuOnSelection(s);
        const menu = await s.rect("[data-context-menu]");
        const editor = await editorBox(s);
        await s.shot("favorites-add", around([{ ...editor, height: Math.max(300, menu.y + menu.height - editor.y) }, menu, item], 14));
      },
    },
    {
      name: "favorites-dialog",
      async run(s) {
        await s.load(seed);
        const item = await openContextMenuOnSelection(s);
        await s.click(item.x + 40, item.y + item.height / 2);
        await s.sleep(350);
        // the name field is focused with its text selected
        await s.type("New customers this year");
        await s.sleep(150);
        const modal = await s.rect("div.rounded-xl.shadow-2xl", "Add to favorites");
        await s.shot("favorites-dialog", around([modal], 28));
      },
    },
    {
      name: "timestamp-tip",
      async run(s) {
        await s.load(seed);
        const cell = await runAndFindTimestampCell(s);
        await s.hover(cell.x + cell.width / 2, cell.y + cell.height / 2);
        await s.sleep(700);
        const tip = await s.rect("div.pointer-events-none.fixed", "Unix timestamp");
        const grid = await s.rect("main > div.rounded-lg");
        await s.shot("timestamp-tip", around([{ ...grid, height: tip.y + tip.height - grid.y }], 0));
      },
    },
    {
      name: "timestamp-picker",
      async run(s) {
        await s.load(seed);
        const cell = await runAndFindTimestampCell(s);
        await s.click(cell.x + cell.width / 2, cell.y + cell.height / 2, "left", 1);
        await s.click(cell.x + cell.width / 2, cell.y + cell.height / 2, "left", 2);
        await s.sleep(500);
        const picker = await s.rect("div.fixed.rounded-xl", "Apply");
        const grid = await s.rect("main > div.rounded-lg");
        await s.shot("timestamp-picker", around([grid, picker], 0));
      },
    },
    {
      name: "schema-focus",
      async run(s) {
        await s.load(seed);
        await s.js(`const { useStore } = await import("/src/store.ts"); useStore.getState().setFocus({ connId: "demo-shop", schema: "public", open: true });`);
        await s.sleep(400);
        const panel = await leftPanel(s);
        await s.shot("schema-focus", { ...panel, height: 420 });
      },
    },
    {
      name: "schema-menu",
      async run(s) {
        await s.load(seed);
        const row = await s.js(`
          const el = [...document.querySelectorAll("span")].find((d) => d.textContent.trim() === "public" && d.getBoundingClientRect().x < 400);
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };`);
        await s.hover(row.x + 20, row.y + row.height / 2);
        await s.click(row.x + 20, row.y + row.height / 2, "right");
        await s.sleep(250);
        const item = await s.rect("[data-context-menu] button", "Truncate schema");
        await s.hover(item.x + 40, item.y + item.height / 2);
        await s.sleep(200);
        const menu = await s.rect("[data-context-menu]");
        const panel = await leftPanel(s);
        await s.shot("schema-menu", around([{ ...panel, height: menu.y + menu.height - panel.y }, menu], 0));
      },
    },
  ],
  "0.1.6": [
    {
      name: "table-doctor",
      async run(s) {
        await s.load(seed);
        await openOrdersDoctor(s);
        const main = await mainBox(s);
        await s.shot("table-doctor", { ...main, height: 690 });
      },
    },
    {
      name: "table-doctor-fix",
      async run(s) {
        await s.load(seed);
        await openOrdersDoctor(s);
        const row = await s.rect("[role=button]", "Foreign key orders_customer_id_fkey");
        await s.click(row.x + 200, row.y + row.height / 2);
        await s.sleep(250);
        const btn = await s.rect("button", "Create index…");
        await s.click(btn.x + btn.width / 2, btn.y + btn.height / 2);
        await s.sleep(400);
        const modal = await s.rect("div.rounded-xl.shadow-2xl", "SQL (you can edit it)");
        await s.shot("table-doctor-fix", around([modal], 28));
      },
    },
    {
      name: "table-doctor-columns",
      async run(s) {
        await s.load(seed);
        await openOrdersDoctor(s);
        await s.js(`[...document.querySelectorAll("section")].find((x) => x.textContent.includes("Column values")).scrollIntoView({ block: "end" });`);
        await s.sleep(200);
        const picker = await s.rect("section header button", "Pick a column");
        await s.click(picker.x + picker.width / 2, picker.y + picker.height / 2);
        await s.sleep(250);
        const opt = await s.rect("div.fixed button", "status");
        await s.click(opt.x + 30, opt.y + opt.height / 2);
        await s.js(`
          const sec = [...document.querySelectorAll("section")].find((x) => x.textContent.includes("Column values"));
          for (let i = 0; i < 30 && !sec.textContent.includes("Distinct values"); i++) await new Promise((r) => setTimeout(r, 100));
          sec.scrollIntoView({ block: "end" });`);
        await s.sleep(400);
        const indexes = await s.rect("section", "Indexes (");
        const columns = await s.rect("section", "Column values");
        await s.shot("table-doctor-columns", around([indexes, columns], 14));
      },
    },
    {
      name: "tree-dots",
      async run(s) {
        await s.load(seed);
        await s.js(`
          const { useStore } = await import("/src/store.ts");
          const { useDoctor } = await import("/src/lib/doctor.ts");
          useStore.getState().setFocus({ connId: "demo-shop", schema: "public", open: true });
          for (let i = 0; i < 50 && !useDoctor.getState().schemas["demo-shop|public"]?.tables; i++) await new Promise((r) => setTimeout(r, 100));`);
        await openOrdersDoctor(s);
        const panel = await leftPanel(s);
        const main = await mainBox(s);
        await s.shot("tree-dots", { x: panel.x, y: panel.y, width: main.x + 520 - panel.x, height: 400 });
      },
    },
    {
      name: "database-doctor",
      async run(s) {
        await s.load(seed);
        await s.js(`
          const { openDbDoctor, useDoctor } = await import("/src/lib/doctor.ts");
          const { useStore } = await import("/src/store.ts");
          openDbDoctor("demo-shop", ["public", "billing"], "shop");
          for (let i = 0; i < 50 && !useDoctor.getState().dbTabs[useStore.getState().activeTabId]?.at; i++) await new Promise((r) => setTimeout(r, 100));
          const { useImports } = await import("/src/lib/importJobs.ts");
          for (const t of useImports.getState().toasts) useImports.getState().closeToast(t.id);`);
        await s.sleep(500);
        const main = await mainBox(s);
        await s.shot("database-doctor", { ...main, height: 760 });
      },
    },
  ],
  "0.1.7": [
    {
      name: "grid-filters",
      async run(s) {
        await s.load(seed);
        await filteredGrid(s);
        const grid = await s.rect("main > div.rounded-lg");
        await s.shot("grid-filters", { ...grid, height: Math.min(grid.height, 360) });
      },
    },
    {
      name: "grid-filter-popover",
      async run(s) {
        await s.load(seed);
        await filteredGrid(s);
        const chip = await s.rect("button[title='Edit filter']", "country");
        await s.click(chip.x + 20, chip.y + chip.height / 2);
        await s.sleep(700);
        const pop = await s.rect("div.fixed.rounded-xl", "Most common values");
        const grid = await s.rect("main > div.rounded-lg");
        await s.shot("grid-filter-popover", around([{ ...grid, height: pop.y + pop.height - grid.y + 10 }, pop], 0));
      },
    },
    {
      name: "slow-queries",
      async run(s) {
        await s.load(seed);
        await openOrdersDoctor(s);
        await s.js(`
          const sec = [...document.querySelectorAll("section")].find((x) => x.textContent.includes("Slow queries"));
          for (let i = 0; i < 40 && !sec.textContent.includes("Suggested indexes"); i++) await new Promise((r) => setTimeout(r, 100));
          sec.scrollIntoView({ block: "start" });`);
        await s.sleep(400);
        const sec = await s.rect("section", "Slow queries");
        await s.shot("slow-queries", { ...sec, x: sec.x - 14, y: sec.y - 14, width: sec.width + 28, height: Math.min(sec.height + 28, 640) });
      },
    },
    {
      name: "what-if",
      async run(s) {
        await s.load(seed);
        await openOrdersDoctor(s);
        await s.js(`
          const sec = [...document.querySelectorAll("section")].find((x) => x.textContent.includes("Slow queries"));
          for (let i = 0; i < 40 && !sec.textContent.includes("Suggested indexes"); i++) await new Promise((r) => setTimeout(r, 100));
          [...sec.querySelectorAll("[role=button]")].find((e) => e.textContent.includes("(customer_id)")).click();
          await new Promise((r) => setTimeout(r, 200));
          [...sec.querySelectorAll("button")].find((b) => b.textContent.includes("What if?")).click();
          for (let i = 0; i < 40 && !sec.textContent.includes("Cost "); i++) await new Promise((r) => setTimeout(r, 100));
          sec.querySelector("h3").scrollIntoView({ block: "start" });`);
        await s.sleep(400);
        const row = await s.rect("section [role=button]", "Index on (customer_id)");
        const result = await s.rect("section div.rounded-md", "Cost ");
        const top = row.y - 52;
        await s.shot("what-if", { x: row.x - 14, y: top, width: row.width + 28, height: result.y + result.height + 14 - top });
      },
    },
    {
      name: "visual-explain",
      async run(s) {
        await s.load(seed);
        await s.js(`
          const { useStore } = await import("/src/store.ts");
          const sql = "SELECT o.id, o.total, c.email\\nFROM orders o\\nJOIN customers c ON c.id = o.customer_id\\nWHERE o.status = 'pending'\\nORDER BY o.created_at DESC;";
          useStore.getState().updateTab("t1", { sql });
          await useStore.getState().explainTab("t1", sql, true);`);
        await s.sleep(600);
        const main = await s.rect("main");
        await s.shot("visual-explain", { ...main, y: main.y + 6, height: main.height - 6 });
      },
    },
  ],
};
