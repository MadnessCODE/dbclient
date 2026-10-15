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
};
