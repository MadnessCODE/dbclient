const REPO = "MadnessCODE/dbclient";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Icons (lucide-style paths)
const ICONS = {
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
  grid: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  arrows: '<path d="M7 4v16m0 0-4-4m4 4 4-4M17 20V4m0 0-4 4m4-4 4 4"/>',
  table: '<path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.5 3.3-5.5 6.5-5.5s5.9 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .6 3.2 2.5 3.5 5.5"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  network: '<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M5 16v-3h14v3M12 8v5"/>',
  import: '<path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
};
$$(".ic[data-i]").forEach((el) => (el.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[el.dataset.i]}</svg>`));

// Reveal on scroll
const io = new IntersectionObserver(
  (es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))),
  { threshold: 0.12 },
);
$$(".reveal").forEach((el) => io.observe(el));

// Card glow follows the mouse
$$(".card").forEach((c) =>
  c.addEventListener("pointermove", (e) => {
    const r = c.getBoundingClientRect();
    c.style.setProperty("--mx", `${e.clientX - r.left}px`);
    c.style.setProperty("--my", `${e.clientY - r.top}px`);
  }),
);

// Floating SQL keywords behind the hero
const words = ["SELECT", "JOIN", "WHERE", "INDEX", "COMMIT", "GROUP BY", "NULL", "FK", "EXPLAIN", "COPY", "VACUUM", "LIMIT", "UNION", "{ }"];
const floating = $(".floating");
if (!reduced)
  words.forEach((w, i) => {
    const s = document.createElement("span");
    s.textContent = w;
    s.style.left = `${4 + ((i * 71) % 92)}%`;
    s.style.top = `${30 + ((i * 37) % 50)}%`;
    s.style.animationDuration = `${9 + (i % 5) * 2}s`;
    s.style.animationDelay = `${-(i * 1.7)}s`;
    floating.appendChild(s);
  });

// Benchmark bars: grow when scrolled into view and on every switch
const bench = $("#bench");
const growBars = (set) => {
  const bars = $$(".b-track i", set);
  bars.forEach((b) => ((b.style.transition = "none"), (b.style.width = "0")));
  void set.offsetWidth;
  bars.forEach((b) => ((b.style.transition = ""), (b.style.width = `${(b.dataset.v / b.dataset.max) * 100}%`)));
};
new IntersectionObserver(
  (es, o) => {
    if (!es[0].isIntersecting) return;
    growBars($(".b-set:not([hidden])", bench));
    bench.classList.add("go");
    o.disconnect();
  },
  { threshold: 0.4 },
).observe(bench);
$$(".b-switch button", bench).forEach((btn) =>
  btn.addEventListener("click", () => {
    $$(".b-switch button", bench).forEach((b) => b.classList.toggle("on", b === btn));
    $$(".b-set", bench).forEach((s) => (s.hidden = s.dataset.set !== btn.dataset.set));
    growBars($(`.b-set[data-set=${btn.dataset.set}]`, bench));
  }),
);

// Scale the 1200x720 mockup to fit
const wrap = $(".frame-wrap");
const frame = $("#app");
function fit() {
  const s = Math.min(1, wrap.clientWidth / 1200);
  frame.style.transform = `scale(${s})`;
  wrap.style.height = `${720 * s}px`;
}
new ResizeObserver(fit).observe(wrap);
fit();

// ---- Demo scenes

$(".tree.clone").innerHTML = $(".scene[data-scene=query] .tree").innerHTML;

let token = 0;
const sleep = (ms, t) => new Promise((res, rej) => setTimeout(() => (t === token ? res() : rej("abort")), ms));

const SQL = [
  ["k", "SELECT"], ["", " c.id, c.name, c.country,\n       "], ["f", "count"], ["o", "("], ["", "o.id"], ["o", ")"], ["k", " AS"], ["", " orders,\n       "],
  ["f", "sum"], ["o", "("], ["", "o.total"], ["o", ")"], ["k", " AS"], ["", " revenue, c.vip\n"],
  ["k", "FROM"], ["", " customers c\n"], ["k", "JOIN"], ["", " orders o "], ["k", "ON"], ["", " o.customer_id = c.id\n"],
  ["k", "WHERE"], ["", " o.created_at >= "], ["f", "now"], ["o", "()"], ["", " - "], ["k", "interval"], ["s", " '30 days'"], ["", "\n"],
  ["k", "GROUP BY"], ["", " c.id "], ["k", "ORDER BY"], ["", " revenue "], ["k", "DESC"], ["k", " LIMIT"], ["n", " 50"], ["o", ";"],
];
const COLS = ["", "id", "name", "country", "orders", "revenue", "last_order", "vip"];
const ROWS = [
  [1042, "Acme Corp", "Germany", 128, "48,210.40", "2026-10-12 14:02", true],
  [877, "Globex", "Serbia", 96, "39,875.00", "2026-10-13 09:41", true],
  [3310, "Initech", "USA", 91, "31,440.15", "2026-10-11 18:20", false],
  [215, "Umbrella Co", "Japan", 74, "28,019.90", "2026-10-13 07:55", true],
  [5120, "Hooli", "USA", 66, "24,600.00", null, false],
  [998, "Vandelay Imports", "Italy", 61, "21,385.75", "2026-10-09 11:12", false],
  [4471, "Stark Industries", "Canada", 58, "19,990.00", "2026-10-12 21:33", true],
  [1763, "Wayne Enterprises", "UK", 52, "18,740.60", "2026-10-10 16:08", false],
  [2650, "Soylent", "France", 47, "15,212.30", "2026-10-08 13:47", false],
  [3908, "Cyberdyne", "Spain", 44, "13,904.00", "2026-10-12 10:26", false],
  [611, "Tyrell Corp", "Netherlands", 39, "12,388.85", "2026-10-07 19:15", false],
];

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

async function sceneQuery(t) {
  const code = $("#sql");
  const grid = $("#grid");
  const info = $("#rinfo");
  const pending = $("#pending");
  const save = $("#save");
  grid.innerHTML = "";
  info.textContent = "";
  pending.classList.remove("show");
  save.classList.remove("show", "press");

  // type the query
  let html = "";
  for (const [cls, text] of SQL) {
    for (let i = 0; i < text.length; i += 2) {
      const part = esc(text.slice(0, i + 2));
      code.innerHTML = html + (cls ? `<span class="${cls}">${part}</span>` : part) + '<span class="cur"></span>';
      await sleep(text[i] === "\n" ? 60 : 16, t);
    }
    html += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text);
  }
  code.innerHTML = html + '<span class="cur"></span>';
  await sleep(350, t);

  // run
  const run = $(".run");
  run.classList.add("press");
  code.classList.add("flash");
  info.innerHTML = "Running…";
  await sleep(160, t);
  run.classList.remove("press");
  await sleep(380, t);
  code.classList.remove("flash");
  grid.innerHTML = `<div class="g-row h">${COLS.map((c, i) => `<span class="${i === 1 || i === 4 || i === 5 ? "num" : ""}">${c}</span>`).join("")}</div>`;
  ROWS.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "g-row";
    row.style.animationDelay = `${i * 45}ms`;
    row.innerHTML =
      `<span class="rn">${i + 1}</span><span class="num">${r[0]}</span><span>${r[1]}</span><span data-c="country">${r[2]}</span>` +
      `<span class="num">${r[3]}</span><span class="num">${r[4]}</span><span>${r[5] ?? '<i class="null">NULL</i>'}</span>` +
      `<span class="${r[6] ? "yes" : ""}">${r[6] ? "✓" : "✗"}</span>`;
    grid.appendChild(row);
  });
  info.innerHTML = `<b>●</b> ${ROWS.length} rows · 38 ms`;
  await sleep(1500, t);

  // edit a cell
  const cell = $$("[data-c=country]", grid)[2];
  cell.classList.add("cell-sel");
  await sleep(600, t);
  for (const v of ["", "C", "Ca", "Can", "Cana", "Canad", "Canada"]) {
    cell.textContent = v;
    cell.classList.add("cell-edit");
    await sleep(70, t);
  }
  pending.textContent = "1 pending change · UPDATE customers SET country = 'Canada' WHERE id = 3310";
  pending.classList.add("show");
  save.classList.add("show");
  await sleep(1300, t);
  save.classList.add("press");
  save.style.transform = "scale(0.92)";
  await sleep(150, t);
  save.style.transform = "";
  cell.classList.remove("cell-edit", "cell-sel");
  pending.textContent = "✓ Saved in one transaction";
  pending.style.color = "var(--ok)";
  save.classList.remove("show");
  await sleep(1600, t);
  pending.style.color = "";
}

const TABLES = ["customers", "orders", "order_items", "products", "payments", "reviews", "addresses", "invoices", "shipments", "coupons"];
async function sceneImport(t) {
  const lanes = $("#lanes");
  const tasks = $(".ri.tasks");
  lanes.innerHTML = "";
  const L = [0, 1, 2, 3].map((i) => {
    const el = document.createElement("div");
    el.className = "lane";
    el.innerHTML = `<span>Worker ${i + 1}</span><div class="pipe"></div><span class="tbl-name">waiting</span>`;
    lanes.appendChild(el);
    return el;
  });
  const status = $("#istatus");
  status.textContent = "Splitting the dump and loading tables in parallel…";
  tasks.classList.add("busy");
  const total = 2918446;
  const secs = 2.0;
  const steps = 50;
  let next = 0;
  for (let s = 0; s <= steps; s++) {
    const p = s / steps;
    const e = 1 - Math.pow(1 - p, 1.6);
    $("#ipct").textContent = `${Math.round(e * 100)}%`;
    $("#ibar").style.width = `${e * 100}%`;
    $("#irows").textContent = Math.round(e * total).toLocaleString("en-US");
    $("#itime").textContent = `${(p * secs).toFixed(1)} s`;
    $("#ispeed").textContent = s ? `${(1.38 + Math.random() * 0.16).toFixed(2)}M rows/s` : "–";
    if (s % 6 === 0 && s < steps) {
      L.forEach((l, i) => {
        const busy = Math.random() > 0.15 || i === s % 4;
        l.classList.toggle("busy", busy);
        l.querySelector(".tbl-name").textContent = busy ? TABLES[next++ % TABLES.length] : "waiting";
      });
    }
    await sleep(100, t);
  }
  L.forEach((l) => {
    l.classList.remove("busy");
    l.classList.add("done");
    l.querySelector(".tbl-name").textContent = "done";
  });
  $("#ispeed").textContent = "1.46M rows/s";
  status.innerHTML = '<span class="ok">✓ Imported 2,918,446 rows in 2.0 s</span> · indexes and foreign keys restored';
  tasks.classList.remove("busy");
  await sleep(2400, t);
}

const PROCS = [
  { pid: 18231, user: "app", app: "api-server", st: "active", d: 0.4, q: "SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC" },
  { pid: 18240, user: "reporting", app: "metabase", st: "active", d: 38, q: "SELECT date_trunc('day', created_at), sum(total) FROM orders o JOIN order_items i …", long: true },
  { pid: 18244, user: "app", app: "api-server", st: "lock", d: 12, q: "UPDATE customers SET vip = true WHERE id = 1042", blocked: true },
  { pid: 18197, user: "app", app: "worker", st: "idle", d: 64, q: "COMMIT" },
  { pid: 18256, user: "admin", app: "DB Client", st: "active", d: 0.1, q: "VACUUM (ANALYZE) products" },
  { pid: 18262, user: "app", app: "api-server", st: "idle", d: 3, q: "SELECT id, name, price FROM products WHERE id = ANY($1)" },
  { pid: 18270, user: "app", app: "worker", st: "idle", d: 7, q: "INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, $3)" },
  { pid: 18275, user: "replicator", app: "walreceiver", st: "active", d: 0.2, q: "START_REPLICATION SLOT replica_1 LOGICAL 0/3A12F08" },
];
function durClass(d) {
  return d < 10 ? "d-ok" : d < 60 ? "d-warn" : "d-bad";
}
async function sceneProcs(t) {
  const table = $("#ptable");
  const locks = $("#locks");
  locks.className = "locks";
  locks.innerHTML = '<b>1 lock wait</b><code>18244 · UPDATE customers …</code><span class="arrow">is blocked by →</span><code>18240 · reporting / metabase</code>';
  const rows = PROCS.map((p) => ({ ...p }));
  $(".p-cards .warn").textContent = "1";
  table.innerHTML = `<div class="p-row h"><span>PID</span><span>User</span><span>State</span><span>Application</span><span>Query</span><span>Time</span><span></span></div>`;
  const els = rows.map((p) => {
    const el = document.createElement("div");
    el.className = `p-row${p.blocked ? " blocked" : ""}`;
    table.appendChild(el);
    return el;
  });
  const label = { active: "active", idle: "idle", lock: "waiting · lock" };
  const cls = { active: "st-active", idle: "st-idle", lock: "st-lock" };
  const render = () =>
    rows.forEach((p, i) => {
      els[i].innerHTML =
        `<span>${p.pid}</span><span>${p.user}</span><span><i class="state ${cls[p.st]}">${label[p.st]}</i></span><span>${p.app}</span>` +
        `<code>${esc(p.q)}</code><span class="dur ${durClass(p.d)}">${p.d < 1 ? `${Math.round(p.d * 1000)} ms` : `${Math.floor(p.d)} s`}</span><span class="kill">Kill</span>`;
    });
  const tick = (n) => rows.forEach((p) => p.st !== "idle" && (p.d += n));
  for (let i = 0; i < 24; i++) {
    tick(i % 3 === 0 ? 1 : 0.1);
    if (rows[0].d > 1.2) rows[0].d = 0.2;
    $("#plong").textContent = `${Math.floor(rows[1].d)} s`;
    render();
    await sleep(100, t);
  }
  els[1].classList.add("sel");
  await sleep(1100, t);
  $(".kill", els[1]).classList.add("press");
  await sleep(250, t);
  els[1].classList.add("gone");
  await sleep(450, t);
  els[1].remove();
  els.splice(1, 1);
  rows.splice(1, 1);
  rows[1].st = "active";
  rows[1].d = 0.05;
  els[1].classList.remove("blocked");
  $(".p-cards .warn").textContent = "0";
  locks.className = "locks clear";
  locks.innerHTML = "<b>✓ No lock waits</b><span>18244 continued as soon as the blocking query was killed.</span>";
  for (let i = 0; i < 20; i++) {
    tick(0.1);
    if (rows[0].d > 1.2) rows[0].d = 0.2;
    $("#plong").textContent = `${Math.floor(Math.max(...rows.filter((r) => r.st === "active").map((r) => r.d)))} s`;
    render();
    await sleep(100, t);
  }
  await sleep(1000, t);
}

const SCENES = { query: [sceneQuery, 12500], import: [sceneImport, 8000], procs: [sceneProcs, 9000] };
const ORDER = ["query", "import", "procs"];
const stage = $(".stage");
let current = "query";
let advance;

function show(name) {
  current = name;
  const t = ++token;
  clearTimeout(advance);
  $(".ri.tasks").classList.remove("busy");
  $$(".scenes button").forEach((b) => b.classList.toggle("on", b.dataset.scene === name));
  $$(".scene").forEach((s) => (s.hidden = s.dataset.scene !== name));
  $$(".ri[data-for]").forEach((r) => r.classList.toggle("on", r.dataset.for === name));
  const [fn, dur] = SCENES[name];
  stage.style.setProperty("--dur", `${dur}ms`);
  // restart the progress animation
  const btn = $(`.scenes button[data-scene=${name}]`);
  btn.classList.remove("on");
  void btn.offsetWidth;
  btn.classList.add("on");
  fn(t).catch(() => {});
  if (!reduced) advance = setTimeout(() => show(ORDER[(ORDER.indexOf(name) + 1) % ORDER.length]), dur);
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
  { threshold: 0.25 },
).observe(stage);

// ---- Downloads: link straight to the latest installers

async function isArm() {
  try {
    const d = await navigator.userAgentData?.getHighEntropyValues(["architecture"]);
    return d?.architecture === "arm";
  } catch {
    return false;
  }
}

const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
const mac = /Mac/i.test(platform);
const linux = !mac && /Linux/i.test(platform) && !/Android/i.test(navigator.userAgent);
const linuxArm = linux && /aarch64|arm/i.test(navigator.platform + navigator.userAgent);
const RELEASES = `https://github.com/${REPO}/releases/latest`;
$$("#linux-pkgs a").forEach((a) => (a.href = RELEASES));

(async () => {
  const arm = !mac && !linux && (await isArm());
  if (linux) {
    $("#dl-linux").classList.replace("secondary", "primary");
    $("#dl-x64").classList.replace("primary", "secondary");
    $("#dl-linux").classList.add("rec");
    $(".download-main .label").textContent = "Download for Linux";
  } else if (mac) {
    $("#dl-mac").classList.replace("secondary", "primary");
    $("#dl-x64").classList.replace("primary", "secondary");
    $("#dl-mac").classList.add("rec");
    $(".download-main .label").textContent = "Download for macOS";
  } else if (arm) {
    $("#dl-arm").classList.replace("secondary", "primary");
    $("#dl-x64").classList.replace("primary", "secondary");
    $("#dl-arm").classList.add("rec");
    $(".download-main .label").textContent = "Download for Windows (ARM64)";
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { cache: "no-cache" });
    if (!r.ok) return;
    const rel = await r.json();
    const asset = (re) => rel.assets.find((a) => re.test(a.name))?.browser_download_url;
    const x64 = asset(/_x64-setup\.exe$/);
    const a64 = asset(/_arm64-setup\.exe$/);
    const dmg = asset(/\.dmg$/);
    const pkgs = {
      "appimage-x64": asset(/_amd64\.AppImage$/),
      "deb-x64": asset(/_amd64\.deb$/),
      "rpm-x64": asset(/\.x86_64\.rpm$/),
      "appimage-arm": asset(/_aarch64\.AppImage$/),
      "deb-arm": asset(/_arm64\.deb$/),
      "rpm-arm": asset(/\.aarch64\.rpm$/),
    };
    $$("#linux-pkgs a").forEach((a) => pkgs[a.dataset.pkg] && (a.href = pkgs[a.dataset.pkg]));
    const appImage = linuxArm ? pkgs["appimage-arm"] : pkgs["appimage-x64"];
    if (x64) $("#dl-x64").href = x64;
    if (a64) $("#dl-arm").href = a64;
    if (dmg) $("#dl-mac").href = dmg;
    if (appImage) $("#dl-linux").href = appImage;
    const main = linux ? appImage : mac ? dmg : arm ? a64 : x64;
    if (main) $(".download-main").href = main;
    $$(".version").forEach((v) => (v.textContent = `${rel.tag_name} beta`));
  } catch {
    // keep the releases page links
  }
})();
