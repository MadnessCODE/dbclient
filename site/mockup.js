// The animated app in the hero. Layout and styles follow the real app (src/components).
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const W = 1280;
  const H = 800;

  const P = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M8 13h8M8 17h6"/>',
    tasks: '<path d="m3 6 2 2 3-3M3 13l2 2 3-3M11 7h10M11 14h10M11 20h10"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2.5 12h3M18.5 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/>',
    minus: '<path d="M5 12h14"/>',
    square: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    folderPlus: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M12 10v6M9 13h6"/>',
    import: '<path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>',
    chevR: '<path d="m9 6 6 6-6 6"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    func: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 17c2 0 2.5-1 3-4l1-5c.5-2 1-3 3-3M8 11h7"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.5 3.3-5.5 6.5-5.5s5.9 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .6 3.2 2.5 3.5 5.5"/>',
    explain: '<path d="M21 12h-8M21 6H8M21 18h-8M3 6v4c0 1.1.9 2 2 2h3M3 10v6c0 1.1.9 2 2 2h3"/>',
    wand: '<path d="m15 4 5 5L9 20H4v-5z"/><path d="M19 2v3M20.5 3.5h-3"/>',
    save: '<path d="M5 3h11l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8 3v5h7M8 21v-7h8v7"/>',
    more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    cols: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M15 9v11"/>',
    msg: '<path d="M4 5h16v11H8l-4 4z"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    download: '<path d="M12 3v12m0 0-4-4m4 4 4-4M4 19h16"/>',
    maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    rows: '<rect x="3" y="4" width="18" height="6" rx="1"/><path d="M3 15h8M3 19h8M17 14v6M14 17h6"/>',
    alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
    plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    hourglass: '<path d="M6 2h12M6 22h12M7 2v4l5 6 5-6V2M7 22v-4l5-6 5 6v4"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
    fileUp: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M12 18v-6m0 0-3 3m3-3 3 3"/>',
    network: '<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M5 16v-3h14v3M12 8v5"/>',
    min2: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    roles: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.5 3.3-5.5 6.5-5.5s5.9 2 6.5 5.5"/>',
  };
  const I = (n, s = 16, cls = "") => `<svg class="mi ${cls}" width="${s}" height="${s}" viewBox="0 0 24 24">${P[n]}</svg>`;
  const PG = (s = 18) =>
    `<svg width="${s}" height="${s}" viewBox="${PG_FULL.viewBox}" style="flex:none">${PG_FULL.outline.map((d) => `<path d="${d}" fill="#fff"/>`).join("")}<path d="${PG_FULL.body}" fill="var(--m-pg)"/><path d="${PG_FULL.details}" fill="#fff"/></svg>`;
  const MY = (s = 18) => `<svg width="${s}" height="${s}" viewBox="${DB_LOGOS.mysql.viewBox}" style="flex:none" fill="var(--m-my)"><path d="${DB_LOGOS.mysql.path}"/></svg>`;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

  // ---- static frame

  const tr = (depth, html, cls = "") => `<div class="m-tr ${cls}" style="padding-left:${6 + depth * 16}px">${html}</div>`;
  const panel = `
    <aside class="m-panel">
      <h4>Connections</h4>
      <div class="m-prow"><span class="m-btn primary" style="flex:1">${I("plus", 15)} New Connection</span><span class="m-btn sq">${I("folderPlus", 15)}</span><span class="m-btn sq">${I("import", 15)}</span></div>
      <div class="m-input">${I("search", 14)} Search connections &amp; projects…</div>
      <div class="m-proj">${I("chevD", 14)}<span class="m-pico">🛒</span> Shop <small>2</small></div>
      <div class="m-conn prod">${I("chevD", 14)}<span class="m-ci">${PG(20)}<i class="on"></i></span><div><b>shop-prod <em class="m-env prod">PROD</em></b><small>PostgreSQL 16.4 • db.shop.io:5432</small></div></div>
      <div>
        ${tr(1, `${I("chevR", 13)}${I("db", 15)}analytics<small>7.4 MB</small>`)}
        ${tr(1, `${I("chevD", 13)}${I("db", 15)}shop<small>497 MB</small>`, "db-on")}
        ${tr(2, `${I("chevD", 13)}${I("db", 15)}store<small>12</small>`)}
        ${tr(3, `${I("chevD", 13)}${I("table", 14)}Tables <span style="color:var(--m-muted)">(12)</span>`)}
        ${tr(4, `<span style="width:13px"></span>${I("table", 14)}customers`, "hl")}
        ${tr(4, `<span style="width:13px"></span>${I("table", 14)}orders`)}
        ${tr(4, `<span style="width:13px"></span>${I("table", 14)}order_items`)}
        ${tr(4, `<span style="width:13px"></span>${I("table", 14)}products`)}
        ${tr(3, `${I("chevR", 13)}${I("eye", 14)}Views <span style="color:var(--m-muted)">(1)</span>`)}
        ${tr(1, `${I("chevR", 13)}${I("users", 15)}Roles`)}
      </div>
      <div class="m-conn stg">${I("chevR", 14)}<span class="m-ci">${MY(20)}<i></i></span><div><b>shop-staging <em class="m-env stg">STAGING</em></b><small>MySQL 8.4 • 10.0.4.12:3306 via bastion</small></div></div>
      <div class="m-sec">NO PROJECT</div>
      <div class="m-conn dev">${I("chevR", 14)}<span class="m-ci">${PG(20)}<i></i></span><div><b>local <em class="m-env dev">DEV</em></b><small>PostgreSQL • localhost:5432</small></div></div>
    </aside>`;

  const work = `
    <div class="m-view" data-view="work">
      ${panel}
      <section class="m-main">
        <div class="m-tabs"><span class="m-tab">${PG(16)} orders.sql</span><span class="m-tab on">${PG(16)} top_customers.sql<span class="x">${I("x", 13)}</span></span><span class="m-plus">${I("plus", 16)}</span></div>
        <div class="m-card m-editor">
          <div class="m-banner">${I("alert", 14)}<b>PRODUCTION · shop-prod</b> — statements that change data ask for confirmation</div>
          <div class="m-tool">
            <span class="m-picker">${PG(16)}<i class="dot"></i>shop-prod <span>/ shop</span><em class="m-env prod">PROD</em>${I("chevD", 15)}</span>
            <span class="m-run" id="m-run"><span>${I("play", 15)} Run</span><i>${I("chevD", 15)}</i></span>
            <span class="m-btn">${I("explain", 15)} Explain</span>
            <span class="m-btn">${I("wand", 15)} Format</span>
            <span class="m-sp"></span><span class="m-ib">${I("save", 17)}</span><span class="m-ib">${I("file", 17)}</span><span class="m-ib">${I("more", 17)}</span>
          </div>
          <pre class="m-code"><ol>${[1, 2, 3, 4, 5, 6].map((n) => `<li>${n}</li>`).join("")}</ol><code id="m-sql"></code></pre>
        </div>
        <div class="m-card m-results">
          <div class="m-rtabs">
            <span class="m-rtab on">${I("table", 15)} Results</span><span class="m-rtab">${I("cols", 15)} Structure</span><span class="m-rtab">${I("msg", 15)} Messages</span><span class="m-rtab">${I("history", 15)} History</span><span class="m-rtab">${I("explain", 15)} Explain Plan</span>
          </div>
          <div class="m-rinfo"><span id="m-rinfo"></span><span class="m-sp"></span><span class="m-btn">${I("download", 15)} Export</span><span class="m-btn sq">${I("maximize", 15)}</span></div>
          <div class="m-grid" id="m-grid"></div>
          <div class="m-rfoot"><span class="m-btn">${I("rows", 15)} Add row</span><span class="m-pend" id="m-pend"></span><span class="m-sp"></span><span class="m-btn primary m-save" id="m-save">${I("save", 15)} Save changes</span><span class="m-pager">‹ <b>1</b> › <span>50 / page ${I("chevD", 14)}</span></span></div>
        </div>
      </section>
    </div>`;

  const procs = `
    <div class="m-view" data-view="procs" hidden>
      <div class="m-procs">
        <div class="m-ph">
          <b>${I("activity", 18)} Processes</b>
          <span class="m-picker">${PG(16)}<i class="dot"></i>shop-prod<em class="m-env prod" style="margin-left:6px">PROD</em>${I("chevD", 15)}</span>
          <span class="m-sp"></span>
          <span class="m-seg"><span class="on">2 s</span><span>5 s</span><span>10 s</span><span>Off</span></span>
          <span class="m-btn sq">${I("pause", 15)}</span><span class="m-btn sq">${I("refresh", 15)}</span>
        </div>
        <div class="m-pbody">
          <div class="m-pmain">
            <div class="m-cards">
              <div><i>${I("plug", 17)}</i><span><small>Sessions</small><b id="p-sess">24</b></span></div>
              <div><i>${I("zap", 17)}</i><span><small>Running now</small><b id="p-run">4</b></span></div>
              <div><i>${I("lock", 17)}</i><span><small>Waiting on locks</small><b class="warn" id="p-lock">1</b></span></div>
              <div><i>${I("hourglass", 17)}</i><span><small>Longest running</small><b id="p-long">41 s</b></span></div>
            </div>
            <div class="m-pf"><span class="m-input">${I("search", 14)} Filter by user, database, query…</span><span class="m-btn">Hide idle</span><span class="m-btn">Show system</span><small id="p-shown">8 of 24 shown</small></div>
            <div class="m-ptable" id="p-table"></div>
          </div>
          <aside class="m-pside" id="p-side"></aside>
        </div>
      </div>
    </div>`;

  const rail = `
    <nav class="m-rail">
      <span class="m-ri">${I("home", 19)}Home</span>
      <span class="m-ri" data-for="work">${I("db", 19)}Connections</span>
      <span class="m-ri">${I("play", 19)}Query</span>
      <span class="m-ri">${I("file", 19)}Files</span>
      <span class="m-ri tasks">${I("tasks", 19)}Tasks<i class="m-badge">1</i></span>
      <span class="m-ri" data-for="procs">${I("activity", 19)}Processes</span>
      <span class="m-ri">${I("settings", 19)}Settings</span>
      <span class="m-ri end">${I("info", 19)}About</span>
    </nav>`;

  const frame = $("#app");
  frame.innerHTML = `
    <div class="m-title">
      <div class="m-brand"><span class="m-logo">${I("db", 19)}</span><div><b>DB Client</b><small>Connect • Query • Explore</small></div></div>
      <div class="m-search">${I("search", 15)} Search tables, columns, SQL…<kbd>Ctrl + K</kbd></div>
      <div class="m-tright"><span class="m-ib">${I("settings", 17)}</span><span class="m-theme"><span>${I("sun", 15)}</span><span class="on">${I("moon", 15)}</span></span><span class="m-win"><span>${I("minus", 16)}</span><span>${I("square", 13)}</span><span>${I("x", 16)}</span></span></div>
    </div>
    <div class="m-body" id="m-body">${rail}${work}${procs}<div class="m-overlay" id="m-overlay" hidden></div></div>`;
  frame.style.display = "flex";
  frame.style.flexDirection = "column";

  const wrap = $(".frame-wrap");
  const fit = () => {
    const s = Math.min(1, wrap.clientWidth / W);
    frame.style.transform = `scale(${s})`;
    wrap.style.height = `${H * s}px`;
  };
  new ResizeObserver(fit).observe(wrap);
  fit();

  // ---- scenes

  let token = 0;
  const sleep = (ms, t) => new Promise((res, rej) => setTimeout(() => (t === token ? res() : rej("stop")), ms));
  const body = $("#m-body");
  const overlay = $("#m-overlay");

  function showView(view, dim = false) {
    $$(".m-view", body).forEach((v) => (v.hidden = v.dataset.view !== view));
    $$(".m-ri[data-for]", body).forEach((r) => r.classList.toggle("on", r.dataset.for === view));
    body.classList.toggle("m-dim", dim);
    overlay.hidden = true;
    overlay.innerHTML = "";
    $(".m-ri.tasks", body).classList.remove("busy");
  }

  const SQL = [
    ["k", "select"], ["", " c.id, c.email, c.name, c.country,\n       "], ["f", "count"], ["o", "("], ["", "o.id"], ["o", ")"], ["k", " as"], ["", " orders, "], ["f", "sum"], ["o", "("], ["", "o.total"], ["o", ")"], ["k", " as"], ["", " revenue\n"],
    ["k", "from"], ["", " store.customers c\n"], ["k", "join"], ["", " store.orders o "], ["k", "on"], ["", " o.customer_id = c.id\n"],
    ["k", "group by"], ["", " c.id\n"], ["k", "order by"], ["", " revenue "], ["k", "desc"], ["k", "\nlimit"], ["n", " 50"], ["o", ";"],
  ];
  const COLS = [["id", "bigint", 1], ["email", "varchar"], ["name", "text"], ["country", "char"], ["orders", "bigint", 0, 1], ["revenue", "numeric", 0, 1], ["last_order", "timestamptz"], ["vip", "bool"]];
  const ROWS = [
    [1042, "ana@acme.io", "Acme Corp", "DE", 128, "48210.40", "2026-10-12 14:02", true],
    [877, "info@globex.io", "Globex", "RS", 96, "39875.00", "2026-10-13 09:41", true],
    [3310, "ops@initech.io", "Initech", "US", 91, "31440.15", "2026-10-11 18:20", false],
    [215, "buy@umbrella.io", "Umbrella Co", "JP", 74, "28019.90", "2026-10-13 07:55", true],
    [5120, "team@hooli.io", "Hooli", "US", 66, "24600.00", null, false],
    [998, "art@vandelay.io", "Vandelay Imports", "IT", 61, "21385.75", "2026-10-09 11:12", false],
    [4471, "tony@stark.io", "Stark Industries", "CA", 58, "19990.00", "2026-10-12 21:33", true],
    [1763, "bruce@wayne.io", "Wayne Enterprises", "GB", 52, "18740.60", "2026-10-10 16:08", false],
    [2650, "hi@soylent.io", "Soylent", "FR", 47, "15212.30", "2026-10-08 13:47", false],
    [3908, "t800@cyberdyne.io", "Cyberdyne", "ES", 44, "13904.00", "2026-10-12 10:26", false],
  ];

  async function sceneQuery(t) {
    showView("work");
    const code = $("#m-sql");
    const grid = $("#m-grid");
    const info = $("#m-rinfo");
    const pend = $("#m-pend");
    const save = $("#m-save");
    grid.innerHTML = "";
    info.innerHTML = '<span style="color:var(--m-muted)">Run a query to see results (Ctrl+Enter)</span>';
    pend.classList.remove("m-show");
    save.classList.remove("m-show");
    let html = "";
    for (const [cls, text] of SQL) {
      for (let i = 0; i < text.length; i += 2) {
        const part = esc(text.slice(0, i + 2));
        code.innerHTML = html + (cls ? `<span class="${cls}">${part}</span>` : part) + '<span class="m-cur"></span>';
        await sleep(text[i] === "\n" ? 50 : 14, t);
      }
      html += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text);
    }
    code.innerHTML = html + '<span class="m-cur"></span>';
    await sleep(300, t);
    const run = $("#m-run");
    run.classList.add("press");
    code.classList.add("m-flash");
    await sleep(160, t);
    run.classList.remove("press");
    await sleep(300, t);
    code.classList.remove("m-flash");
    grid.innerHTML =
      `<div class="m-gr h"><span></span>` +
      COLS.map(([n, ty, pk, num]) => `<span class="${num || pk ? "num" : ""}"><span>${pk ? '<b class="pk">PK</b>' : ""}${n}</span><small>${ty}</small></span>`).join("") +
      "</div>";
    ROWS.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "m-gr";
      row.style.animationDelay = `${i * 40}ms`;
      row.innerHTML =
        `<span class="gut"><i></i></span><span class="num">${r[0]}</span><span>${r[1]}</span><span>${r[2]}</span><span data-c="country">${r[3]}</span>` +
        `<span class="num">${r[4]}</span><span class="num">${r[5]}</span><span>${r[6] ?? '<i class="m-null">NULL</i>'}</span>` +
        `<span class="${r[7] ? "m-yes" : "m-no"}">${r[7] ? "✓" : "✗"}</span>`;
      grid.appendChild(row);
    });
    info.innerHTML = `${I("check", 18)} 50 rows returned in 38 ms`;
    await sleep(1500, t);

    // edit a cell, then the production guard asks before saving
    const cell = $$("[data-c=country]", grid)[2];
    cell.classList.add("m-sel");
    await sleep(500, t);
    for (const v of ["", "C", "CA"]) {
      cell.textContent = v;
      cell.classList.add("m-edit");
      await sleep(110, t);
    }
    pend.textContent = "1 change · UPDATE store.customers SET country = 'CA' WHERE id = 3310";
    pend.classList.add("m-show");
    save.classList.add("m-show");
    await sleep(1200, t);
    save.classList.add("press");
    await sleep(150, t);
    save.classList.remove("press");
    overlay.hidden = false;
    overlay.innerHTML = `<div class="m-modal" style="width:440px"><div class="m-mh">${I("alert", 18, "")} Production database<span></span></div>
      <div class="m-mb" style="font-size:13px;color:var(--m-fg-2)">You're about to change data on <b style="color:#f87171">shop-prod</b> (PROD):<code class="mono" style="font-size:12px;color:var(--m-fg)">UPDATE store.customers SET country = 'CA' WHERE id = 3310</code></div>
      <div class="m-mf"><span class="m-sp"></span><span class="m-btn">Cancel</span><span class="m-btn danger" id="m-confirm">Run on production</span></div></div>`;
    await sleep(1400, t);
    $("#m-confirm").classList.add("press");
    await sleep(160, t);
    overlay.hidden = true;
    cell.classList.remove("m-edit", "m-sel");
    pend.textContent = "✓ Saved in one transaction";
    pend.style.color = "var(--m-ok)";
    save.classList.remove("m-show");
    await sleep(1600, t);
    pend.style.color = "";
  }

  async function sceneImport(t) {
    showView("work", true);
    $("#m-grid").innerHTML = "";
    $(".m-ri.tasks", body).classList.add("busy");
    overlay.hidden = false;
    overlay.innerHTML = `<div class="m-modal m-import">
      <div class="m-mh">Import ${I("x", 17)}</div>
      <div class="m-mt">${I("fileUp", 15)}<b>shop_2026-10.sql.gz</b><span style="color:var(--m-muted)">→</span> shop-prod / shop</div>
      <div class="m-mb">
        <div class="m-ist"><span class="m-spin" id="i-icon"></span><span><b id="i-title">Importing…</b><small id="i-sub">Reading the file…</small></span><span class="pct" id="i-pct">0%</span></div>
        <div class="m-bar"><i id="i-bar"></i></div>
        <div class="m-stats"><div><small>Elapsed</small><b id="i-el">0.0 s</b></div><div><small>Speed</small><b id="i-sp">—</b></div><div><small>Time left</small><b id="i-left">—</b></div><div><small>Rows</small><b id="i-rows">0</b></div><div><small>Statements</small><b id="i-st">0</b></div></div>
        <div class="m-lh"><span>CONNECTIONS</span><span id="i-work">0 of 4 working</span></div>
        <div id="i-lanes"></div>
        <div class="m-done-note" id="i-note" style="visibility:hidden">${I("check", 15)} All statements ran without errors. The schema tree was refreshed.</div>
      </div>
      <div class="m-mf"><span id="i-foot">You can keep working — the import runs in the background.</span><span class="m-sp"></span><span class="m-btn">${I("min2", 14)} Run in background</span><span class="m-btn danger">${I("stop", 12)} Stop import</span></div>
    </div>`;
    const lanes = ["main", "#1", "#2", "#3"].map((n, i) => {
      const el = document.createElement("div");
      el.className = `m-lane${i === 0 ? " main" : ""}`;
      el.innerHTML = `<span class="${i === 0 ? "main" : ""}">${n}</span><div class="m-pipe">waiting</div><span>0</span>`;
      $("#i-lanes").appendChild(el);
      return el;
    });
    const tables = ["store.orders", "store.order_items", "store.customers", "store.payments", "store.products", "store.reviews", "store.shipments", "store.addresses"];
    const total = 2918446;
    const secs = 2.0;
    const steps = 44;
    const jobs = [0, 0, 0, 0];
    let k = 0;
    for (let s = 0; s <= steps; s++) {
      const p = s / steps;
      const e = 1 - Math.pow(1 - p, 1.5);
      $("#i-pct").textContent = `${Math.floor(e * 100)}%`;
      $("#i-bar").style.width = `${e * 100}%`;
      $("#i-el").textContent = `${(p * secs).toFixed(1)} s`;
      $("#i-rows").textContent = Math.round(e * total).toLocaleString("en-US");
      $("#i-st").textContent = Math.round(e * 1240).toLocaleString("en-US");
      $("#i-sp").textContent = s ? `${(270 + Math.random() * 30).toFixed(1)} MB/s` : "—";
      $("#i-left").textContent = s && s < steps ? `~${((1 - p) * secs).toFixed(1)} s` : "—";
      if (s % 5 === 1 && s < steps) {
        let busy = 0;
        lanes.forEach((l, i) => {
          const on = i === 0 ? s < 8 || s > 36 : Math.random() > 0.12;
          l.classList.toggle("busy", on);
          if (on) {
            busy++;
            jobs[i]++;
            const tb = i === 0 ? (s < 8 ? "CREATE TABLE …" : "CREATE INDEX …") : tables[k++ % tables.length];
            l.querySelector(".m-pipe").innerHTML = i === 0 ? `<em>SQL</em> ${tb}` : `<em>COPY</em> ${tb}`;
          } else l.querySelector(".m-pipe").textContent = "waiting";
          l.lastElementChild.textContent = jobs[i];
        });
        $("#i-work").textContent = `${busy} of 4 working`;
        $("#i-sub").textContent = `Working on ${tables[(k - 1) % tables.length]}`;
      }
      await sleep(95, t);
    }
    lanes.forEach((l) => {
      l.classList.remove("busy");
      l.querySelector(".m-pipe").textContent = "done";
    });
    $("#i-work").textContent = "4 parallel";
    $("#i-icon").outerHTML = `<span style="color:var(--m-ok)">${I("check", 22)}</span>`;
    $("#i-title").textContent = "Import finished";
    $("#i-title").classList.add("ok");
    $("#i-sub").textContent = "2.0 s total · 2,918,446 rows";
    $("#i-bar").style.background = "var(--m-ok)";
    $("#i-note").style.visibility = "visible";
    $("#i-foot").textContent = "";
    $(".m-ri.tasks", body).classList.remove("busy");
    await sleep(2600, t);
  }

  // ER diagram: table, kind, x, y, columns [name, type, key]
  const ER = [
    ["suppliers", "table", 30, 30, [["id", "integer", "pk"], ["name", "text"], ["phone", "text"]]],
    ["categories", "table", 30, 190, [["id", "integer", "pk"], ["parent_id", "integer", "fk"], ["name", "text"]]],
    ["customers", "table", 30, 350, [["id", "bigint", "pk"], ["email", "varchar(200)"], ["name", "text"], ["country", "char(2)"]]],
    ["products", "table", 300, 40, [["id", "bigint", "pk"], ["category_id", "integer", "fk"], ["supplier_id", "integer", "fk"], ["sku", "varchar(40)"], ["price", "numeric(10,2)"]]],
    ["addresses", "table", 300, 330, [["id", "bigint", "pk"], ["customer_id", "bigint", "fk"], ["city", "text"], ["zip", "varchar(16)"]]],
    ["reviews", "table", 570, 30, [["id", "bigint", "pk"], ["product_id", "bigint", "fk"], ["customer_id", "bigint", "fk"], ["rating", "smallint"]]],
    ["orders", "table", 570, 250, [["id", "bigint", "pk"], ["customer_id", "bigint", "fk"], ["address_id", "bigint", "fk"], ["status", "varchar(20)"], ["total", "numeric(12,2)"], ["created_at", "timestamptz"]]],
    ["shipments", "table", 850, 20, [["id", "bigint", "pk"], ["order_id", "bigint", "fk"], ["carrier", "text"]]],
    ["payments", "table", 850, 170, [["id", "bigint", "pk"], ["order_id", "bigint", "fk"], ["amount", "numeric(12,2)"], ["paid_at", "timestamptz"]]],
    ["order_items", "table", 850, 350, [["order_id", "bigint", "pk"], ["product_id", "bigint", "pk"], ["qty", "integer"], ["price", "numeric(10,2)"]]],
    ["order_totals", "view", 600, 470, [["id", "bigint"], ["customer_id", "bigint"], ["total", "numeric"]]],
  ];
  const ER_FK = [
    ["products", "category_id", "categories", "id"], ["products", "supplier_id", "suppliers", "id"], ["addresses", "customer_id", "customers", "id"],
    ["reviews", "product_id", "products", "id"], ["reviews", "customer_id", "customers", "id"], ["orders", "customer_id", "customers", "id"],
    ["orders", "address_id", "addresses", "id"], ["shipments", "order_id", "orders", "id"], ["payments", "order_id", "orders", "id"],
    ["order_items", "order_id", "orders", "id"], ["order_items", "product_id", "products", "id"], ["categories", "parent_id", "categories", "id"],
  ];
  const ET_W = 200;
  const rowY = (t, col) => {
    const i = ER.find((x) => x[0] === t)[4].findIndex((c) => c[0] === col);
    return 30 + i * 21 + 10.5;
  };

  function erEdges(sel) {
    const pos = Object.fromEntries(ER.map((e) => [e[0], e]));
    return ER_FK.map(([a, ac, b, bc]) => {
      const [, , ax, ay] = pos[a];
      const [, , bx, by] = pos[b];
      const ya = ay + rowY(a, ac);
      const yb = by + rowY(b, bc);
      const hl = sel && (a === sel || b === sel) ? ' class="hl"' : "";
      if (a === b) {
        const x = ax + ET_W;
        return `<path${hl} d="M${x} ${ya} C${x + 50} ${ya}, ${x + 50} ${yb}, ${x} ${yb} M${x + 10} ${ya} L${x} ${ya - 5} M${x + 10} ${ya} L${x} ${ya + 5} M${x + 8} ${yb - 5} L${x + 8} ${yb + 5}"/>`;
      }
      const right = bx > ax;
      const xa = right ? ax + ET_W : ax;
      const xb = right ? bx : bx + ET_W;
      const dir = right ? 1 : -1;
      const bend = Math.max(40, Math.abs(xb - xa) / 2);
      return `<path${hl} d="M${xa} ${ya} C${xa + dir * bend} ${ya}, ${xb - dir * bend} ${yb}, ${xb} ${yb} M${xa + dir * 11} ${ya} L${xa} ${ya - 5} M${xa + dir * 11} ${ya} L${xa} ${ya + 5} M${xb - dir * 8} ${yb - 5} L${xb - dir * 8} ${yb + 5}"/>`;
    }).join("");
  }

  async function sceneEr(t) {
    showView("work", true);
    overlay.hidden = false;
    overlay.innerHTML = `<div class="m-modal m-er">
      <div class="m-mh">${I("network", 18)}<span class="t">ER diagram · shop.store<small>shop-prod · PostgreSQL · 12 tables and views</small></span><span class="m-sp"></span>
        <span class="m-saved" id="e-saved">${I("check", 14)} Saved to shop.store-er.html</span>
        <span class="m-ib">${I("refresh", 16)}</span><span class="m-btn primary" id="e-export">${I("download", 15)} Export HTML</span><span class="m-ib">${I("x", 17)}</span></div>
      <div class="m-ertb"><span class="m-seg"><span class="on">Diagram</span><span>Documentation</span></span><span class="m-input" id="e-search">Search tables and columns… ( / )</span><span class="m-sp"></span>
        <span class="m-btn">Keys only</span><span class="m-btn">Fit</span><span class="m-btn sq">−</span><span class="m-btn sq">+</span><span class="m-btn sq">◐</span></div>
      <div class="m-erbody"><div class="m-canvas" id="e-canvas"><svg id="e-svg"></svg></div><div class="m-erside" id="e-side"><div></div></div></div>
    </div>`;
    const canvas = $("#e-canvas");
    const svg = $("#e-svg");
    ER.forEach(([name, kind, x, y, cols], i) => {
      const el = document.createElement("div");
      el.className = `m-et${kind === "view" ? " view" : ""}`;
      el.dataset.name = name;
      el.style.left = `${x + 24}px`;
      el.style.top = `${y + 20}px`;
      el.style.animationDelay = `${i * 55}ms`;
      el.innerHTML =
        `<div class="hd">${name}${kind === "view" ? "<i>VIEW</i>" : ""}</div>` +
        cols.map(([c, ty, key]) => `<div class="r"><b class="${key || ""}">${key ? key.toUpperCase() : ""}</b>${c}<small>${ty}</small></div>`).join("") +
        '<div class="pad"></div>';
      canvas.appendChild(el);
    });
    svg.style.transform = "translate(24px, 20px)";
    svg.style.opacity = "0";
    svg.style.transition = "opacity 0.5s";
    svg.innerHTML = erEdges(null);
    await sleep(700, t);
    svg.style.opacity = "1";
    await sleep(1300, t);

    // select a table: related ones light up, details slide in
    const pick = (name) => {
      canvas.classList.add("m-focus");
      const rel = new Set([name, ...ER_FK.filter((f) => f[0] === name || f[2] === name).flatMap((f) => [f[0], f[2]])]);
      $$(".m-et", canvas).forEach((e) => {
        e.classList.toggle("sel", e.dataset.name === name);
        e.classList.toggle("hl", rel.has(e.dataset.name));
      });
      svg.innerHTML = erEdges(name);
    };
    pick("orders");
    const side = $("#e-side");
    side.firstElementChild.innerHTML = `<h5>orders <em>TABLE</em></h5>
      <h6>COLUMNS</h6><table><tr><th>Name</th><th>Type</th><th>Null</th></tr>
      ${ER.find((e) => e[0] === "orders")[4].map(([c, ty, k]) => `<tr><td>${k ? `<b style="font-size:9px;color:${k === "pk" ? "var(--m-warn)" : "#60a5fa"}">${k.toUpperCase()}</b> ` : ""}${c}</td><td class="mono" style="color:var(--m-fg-2)">${ty}</td><td>${k ? '<span style="color:var(--m-muted)">no</span>' : "yes"}</td></tr>`).join("")}</table>
      <h6>REFERENCES</h6><ul><li><code>customer_id</code> → <a>customers</a></li><li><code>address_id</code> → <a>addresses</a></li></ul>
      <h6>REFERENCED BY</h6><ul><li><a>shipments</a> (order_id)</li><li><a>payments</a> (order_id)</li><li><a>order_items</a> (order_id)</li></ul>`;
    side.classList.add("open");
    await sleep(2600, t);
    side.classList.remove("open");
    canvas.classList.remove("m-focus");
    $$(".m-et", canvas).forEach((e) => e.classList.remove("sel", "hl"));
    svg.innerHTML = erEdges(null);

    // search highlights matching tables
    const search = $("#e-search");
    search.classList.add("typing");
    for (const v of ["c", "cu", "cus", "cust"]) {
      search.textContent = v;
      await sleep(120, t);
    }
    canvas.classList.add("m-searching");
    $$(".m-et", canvas).forEach((e) => e.classList.toggle("match", /cust/.test(e.dataset.name) || ["addresses", "reviews", "orders", "order_totals"].includes(e.dataset.name)));
    await sleep(1600, t);
    canvas.classList.remove("m-searching");
    search.classList.remove("typing");
    search.textContent = "Search tables and columns… ( / )";

    const exp = $("#e-export");
    exp.classList.add("press");
    await sleep(160, t);
    exp.classList.remove("press");
    await sleep(300, t);
    $("#e-saved").style.opacity = "1";
    await sleep(1800, t);
  }

  const PROCS = [
    { pid: 18231, user: "app", db: "shop", app: "api", st: "active", d: 0.4, q: "SELECT * FROM store.orders WHERE customer_id = $1 ORDER BY created_at DESC" },
    { pid: 18240, user: "reporting", db: "shop", app: "metabase", st: "active", d: 38, q: "SELECT date_trunc('day', created_at), sum(total) FROM store.orders o JOIN store.order_items i ON …", long: true },
    { pid: 18244, user: "app", db: "shop", app: "api", st: "lock", d: 12, q: "UPDATE store.customers SET vip = true WHERE id = 1042" },
    { pid: 18256, user: "admin", db: "shop", app: "DB Client", st: "active", d: 2, q: "VACUUM (ANALYZE) store.products" },
    { pid: 18262, user: "app", db: "shop", app: "api", st: "idle", d: 3, q: "SELECT id, name, price FROM store.products WHERE id = ANY($1)" },
    { pid: 18270, user: "worker", db: "shop", app: "jobs", st: "idle", d: 7, q: "INSERT INTO store.payments (order_id, amount) VALUES ($1, $2)" },
    { pid: 18275, user: "app", db: "analytics", app: "api", st: "active", d: 0.2, q: "SELECT count(*) FROM events WHERE at > now() - interval '1 hour'" },
    { pid: 18281, user: "app", db: "shop", app: "api", st: "idle", d: 9, q: "COMMIT" },
  ];
  const dur = (d) => (d < 1 ? `${Math.round(d * 1000)} ms` : `${Math.floor(d)} s`);
  const durCls = (d) => (d < 10 ? "" : d < 60 ? "d-warn" : "d-bad");

  async function sceneProcs(t) {
    showView("procs");
    const rows = PROCS.map((p) => ({ ...p }));
    const table = $("#p-table");
    const side = $("#p-side");
    $("#p-lock").textContent = "1";
    $("#p-run").textContent = "4";
    $("#p-shown").textContent = "8 of 24 shown";
    const label = { active: "active", idle: "idle", lock: "active" };
    let sel = null;
    const render = () => {
      table.innerHTML =
        '<div class="m-prow2 h"><span></span><span>PID</span><span>USER</span><span>DATABASE</span><span>CLIENT</span><span>STATE</span><span class="d">DURATION</span><span class="q">QUERY</span></div>' +
        rows
          .map(
            (p) =>
              `<div class="m-prow2${p.pid === sel ? " sel" : ""}${p.st === "lock" ? " blocked" : ""}${p.gone ? " gone" : ""}"><span><i class="dot ${p.st === "active" ? "on" : p.st === "lock" ? "lock" : ""}"></i></span><span>${p.pid}</span><span>${p.user}</span><span>${p.db}</span><span><i class="m-app" style="font-style:normal">${p.app}</i></span><span class="m-st ${p.st === "lock" ? "lock" : p.st === "active" ? "act" : ""}">${label[p.st]}${p.st === "lock" ? " <small>(Lock: transactionid)</small>" : ""}</span><span class="d ${durCls(p.d)}">${dur(p.d)}</span><span class="q">${esc(p.q)}</span></div>`,
          )
          .join("");
    };
    const detail = (p) => {
      side.innerHTML = `<h5>Process ${p.pid} ${I("x", 16)}</h5>
        <div class="m-kv"><span>User</span><span>${p.user}</span><span>Database</span><span>${p.db}</span><span>Client</span><span>10.0.3.17</span><span>Application</span><span>${p.app}</span><span>State</span><span>${p.st === "lock" ? "active" : p.st}</span><span>Duration</span><span class="${durCls(p.d)}">${dur(p.d)}</span>${p.long ? "<span>Blocking</span><span style=\"color:var(--m-warn)\">PID 18244</span>" : ""}</div>
        <h6>QUERY</h6><div class="m-qbox">${esc(p.long ? "SELECT date_trunc('day', created_at) AS day,\n       sum(total)\nFROM store.orders o\nJOIN store.order_items i ON i.order_id = o.id\nGROUP BY 1\nORDER BY 1;" : p.q)}</div>
        <div class="m-pfoot"><span class="m-btn">${I("ban", 15)} Cancel query</span><span class="m-btn danger" id="p-kill">${I("x", 15)} Kill connection</span></div>`;
    };
    detail(rows[0]);
    sel = rows[0].pid;
    const tick = (n) => rows.forEach((p) => p.st !== "idle" && (p.d += n));
    for (let i = 0; i < 14; i++) {
      tick(i % 3 === 0 ? 1 : 0.1);
      if (rows[0].d > 1.2) rows[0].d = 0.2;
      $("#p-long").textContent = `${Math.floor(rows[1].d)} s`;
      render();
      await sleep(110, t);
    }
    sel = rows[1].pid;
    detail(rows[1]);
    for (let i = 0; i < 12; i++) {
      tick(i % 3 === 0 ? 1 : 0.1);
      if (rows[0].d > 1.2) rows[0].d = 0.2;
      $("#p-long").textContent = `${Math.floor(rows[1].d)} s`;
      render();
      detail(rows[1]);
      await sleep(110, t);
    }
    $("#p-kill").classList.add("press");
    await sleep(200, t);
    rows[1].gone = true;
    render();
    await sleep(400, t);
    rows.splice(1, 1);
    rows[1].st = "active";
    rows[1].d = 0.05;
    sel = rows[1].pid;
    detail(rows[1]);
    $("#p-lock").textContent = "0";
    $("#p-shown").textContent = "7 of 23 shown";
    for (let i = 0; i < 18; i++) {
      tick(0.1);
      if (rows[0].d > 1.2) rows[0].d = 0.2;
      $("#p-long").textContent = `${Math.floor(Math.max(...rows.filter((r) => r.st === "active").map((r) => r.d)))} s`;
      render();
      await sleep(110, t);
    }
    await sleep(900, t);
  }

  const SCENES = { query: [sceneQuery, 13500], import: [sceneImport, 8200], er: [sceneEr, 10500], procs: [sceneProcs, 9500] };
  const ORDER = Object.keys(SCENES);
  const stage = $(".stage");
  let current = "query";
  let advance;

  function show(name) {
    current = name;
    const t = ++token;
    clearTimeout(advance);
    const [fn, ms] = SCENES[name];
    stage.style.setProperty("--dur", `${ms}ms`);
    $$(".scenes button").forEach((b) => b.classList.remove("on"));
    const btn = $(`.scenes button[data-scene=${name}]`);
    void btn.offsetWidth;
    btn.classList.add("on");
    fn(t).catch(() => {});
    if (!reduced) advance = setTimeout(() => show(ORDER[(ORDER.indexOf(name) + 1) % ORDER.length]), ms);
  }
  $$(".scenes button").forEach((b) => b.addEventListener("click", () => show(b.dataset.scene)));

  let started = false;
  new IntersectionObserver(
    (es) => {
      if (es[0].isIntersecting && !started) {
        started = true;
        show(current);
      }
    },
    { threshold: 0.2 },
  ).observe(stage);
})();
