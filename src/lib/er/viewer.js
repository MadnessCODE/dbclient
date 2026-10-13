// ER diagram viewer. Self-contained: reads the model from <script id="er-model"> and renders
// the diagram and the documentation. Used as is in the app (iframe) and in exported HTML files.
(() => {
  const M = JSON.parse(document.getElementById("er-model").textContent);
  const HEAD = 36;
  const ROW = 24;
  const PAD = 5;
  const GAP_X = 120;
  const GAP_Y = 36;

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  if (M.theme === "light") document.body.classList.add("light");
  if (M.embedded) document.body.classList.add("embedded");

  // PostgreSQL spells some types out; the diagram uses the usual short names
  const SHORT = [
    [/^character varying/, "varchar"],
    [/^character\b/, "char"],
    [/^timestamp\((\d)\) with time zone|^timestamp with time zone/, (m, p) => (p ? `timestamptz(${p})` : "timestamptz")],
    [/^timestamp\((\d)\) without time zone|^timestamp without time zone/, (m, p) => (p ? `timestamp(${p})` : "timestamp")],
    [/^time with time zone/, "timetz"],
    [/^time without time zone/, "time"],
    [/^double precision/, "float8"],
    [/^bit varying/, "varbit"],
  ];
  const shortType = (t) => SHORT.reduce((s, [re, to]) => s.replace(re, to), t);

  const tables = M.tables;
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const t of tables) t.fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns));
  // edges between tables of this schema; refs to other schemas only appear in the docs
  const edges = [];
  for (const t of tables)
    for (const fk of t.foreignKeys) if (fk.refSchema === M.schema && byName.has(fk.refTable)) edges.push({ from: t.name, to: fk.refTable, fk });
  const referencedBy = new Map(tables.map((t) => [t.name, []]));
  for (const e of edges) referencedBy.get(e.to).push(e);

  // ---- layout

  const SANS = getComputedStyle(document.body).fontFamily;
  const MONO = '"JetBrains Mono", "Cascadia Code", Consolas, monospace';
  const measure = document.createElement("canvas").getContext("2d");
  const textW = (s, font) => ((measure.font = font), measure.measureText(s).width);
  let keysOnly = false;

  function visibleColumns(t) {
    if (!keysOnly) return t.columns;
    return t.columns.filter((c) => c.primaryKey || t.fkCols.has(c.name));
  }
  function sizeOf(t) {
    const cols = visibleColumns(t);
    let w = textW(t.name, `600 13px ${SANS}`) + 80;
    for (const c of cols) w = Math.max(w, textW(c.name, `500 13px ${SANS}`) + textW(shortType(c.dataType), `11.5px ${MONO}`) + 76);
    const hidden = t.columns.length - cols.length;
    return { w: Math.round(Math.min(460, Math.max(190, w))), h: HEAD + cols.length * ROW + (hidden ? 24 : 0) + PAD };
  }

  const pos = new Map();
  function autoLayout() {
    const parents = new Map(tables.map((t) => [t.name, new Set()]));
    const adj = new Map(tables.map((t) => [t.name, new Set()]));
    for (const e of edges) {
      if (e.from === e.to) continue;
      parents.get(e.from).add(e.to);
      adj.get(e.from).add(e.to);
      adj.get(e.to).add(e.from);
    }
    // referenced tables to the left, tables that point at them to the right
    const layer = new Map();
    const visiting = new Set();
    const depth = (n) => {
      if (layer.has(n)) return layer.get(n);
      if (visiting.has(n)) return 0;
      visiting.add(n);
      let d = 0;
      for (const p of parents.get(n)) d = Math.max(d, depth(p) + 1);
      visiting.delete(n);
      layer.set(n, d);
      return d;
    };
    tables.forEach((t) => depth(t.name));

    const seen = new Set();
    const comps = [];
    for (const t of tables) {
      if (seen.has(t.name)) continue;
      const comp = [];
      const stack = [t.name];
      seen.add(t.name);
      while (stack.length) {
        const n = stack.pop();
        comp.push(n);
        for (const m of adj.get(n)) if (!seen.has(m)) (seen.add(m), stack.push(m));
      }
      comps.push(comp);
    }
    const groups = comps.filter((c) => c.length > 1).sort((a, b) => b.length - a.length);
    const singles = comps.filter((c) => c.length === 1).map((c) => c[0]);

    const sizes = new Map(tables.map((t) => [t.name, sizeOf(t)]));
    const totalArea = tables.reduce((a, t) => a + (sizes.get(t.name).w + GAP_X) * (sizes.get(t.name).h + GAP_Y), 0);
    const rowLimit = Math.max(1600, Math.sqrt(totalArea) * 1.7);
    let cx = 0;
    let cy = 0;
    let rowH = 0;
    const place = (w, h) => {
      if (cx > 0 && cx + w > rowLimit) {
        cx = 0;
        cy += rowH + 140;
        rowH = 0;
      }
      const at = { x: cx, y: cy };
      cx += w + 160;
      rowH = Math.max(rowH, h);
      return at;
    };

    for (const comp of groups) {
      const layers = [];
      for (const n of comp) (layers[layer.get(n)] ??= []).push(n);
      const cols = layers.filter(Boolean);
      // order inside a layer by the average position of neighbours in the previous one
      for (let pass = 0; pass < 2; pass++)
        for (let i = 1; i < cols.length; i++) {
          const idx = new Map(cols[i - 1].map((n, k) => [n, k]));
          const bary = (n) => {
            const ks = [...adj.get(n)].filter((m) => idx.has(m)).map((m) => idx.get(m));
            return ks.length ? ks.reduce((a, b) => a + b, 0) / ks.length : 1e9;
          };
          cols[i].sort((a, b) => bary(a) - bary(b));
        }
      const colW = cols.map((c) => Math.max(...c.map((n) => sizes.get(n).w)));
      const colH = cols.map((c) => c.reduce((a, n) => a + sizes.get(n).h + GAP_Y, -GAP_Y));
      const w = colW.reduce((a, b) => a + b + GAP_X, -GAP_X);
      const h = Math.max(...colH);
      const at = place(w, h);
      let x = at.x;
      cols.forEach((c, i) => {
        let y = at.y + (h - colH[i]) / 2;
        for (const n of c) {
          pos.set(n, { x, y });
          y += sizes.get(n).h + GAP_Y;
        }
        x += colW[i] + GAP_X;
      });
    }
    // unrelated tables in a grid
    if (singles.length) {
      const per = Math.max(1, Math.ceil(Math.sqrt(singles.length * 1.6)));
      const colW = Math.max(...singles.map((n) => sizes.get(n).w));
      for (let i = 0; i < singles.length; i += per) {
        const chunk = singles.slice(i, i + per);
        const h = chunk.reduce((a, n) => a + sizes.get(n).h + GAP_Y, -GAP_Y);
        const at = place(colW, h);
        let y = at.y;
        for (const n of chunk) {
          pos.set(n, { x: at.x, y });
          y += sizes.get(n).h + GAP_Y;
        }
      }
    }
  }

  // ---- DOM

  const root = el("div");
  root.id = "er";
  root.innerHTML = `
    <div class="bar">
      <div class="title"><b>${esc(M.title)}</b><small>${esc(M.subtitle || "")}</small></div>
      <div class="seg"><button data-view="diagram" class="on">Diagram</button><button data-view="docs">Documentation</button></div>
      <input class="search" placeholder="Search tables and columns…  ( / )" />
      <span class="spacer"></span>
      <button class="btn" data-act="keys" title="Show only key columns">Keys only</button>
      <button class="btn" data-act="fit" title="Fit to screen (F)">Fit</button>
      <button class="btn" data-act="out" title="Zoom out">−</button>
      <button class="btn" data-act="in" title="Zoom in">+</button>
      <button class="btn" data-act="theme" title="Light / dark">◐</button>
      <a class="credit" href="https://madnesscode.github.io/dbclient/" target="_blank" rel="noopener">DB Client</a>
    </div>
    <div class="main">
      <div id="viewport"><div id="world"><svg id="edges"></svg></div></div>
      <div id="details"></div>
      <div id="docs"><div class="toc"></div><div class="sections"></div></div>
    </div>`;
  document.body.appendChild(root);

  const viewport = root.querySelector("#viewport");
  const world = root.querySelector("#world");
  const svg = root.querySelector("#edges");
  const details = root.querySelector("#details");
  const docs = root.querySelector("#docs");
  const search = root.querySelector(".search");
  const nodes = new Map();
  let view = { x: 40, y: 40, k: 1 };
  let selected = null;

  if (!tables.length) {
    viewport.innerHTML = '<div class="empty">This schema has no tables.</div>';
  }

  function renderNode(t) {
    const old = nodes.get(t.name);
    const n = el("div", `tbl${t.kind === "view" ? " view" : ""}`);
    n.dataset.name = t.name;
    const cols = visibleColumns(t);
    let html = `<div class="hd"><span>${esc(t.name)}</span>${t.kind === "view" ? "<i>view</i>" : ""}</div>`;
    for (const c of cols) {
      const k = c.primaryKey ? '<span class="k pk">PK</span>' : t.fkCols.has(c.name) ? '<span class="k fk">FK</span>' : '<span class="k"></span>';
      html += `<div class="row" title="${esc(c.comment || "")}">${k}<span class="n${c.nullable ? "" : " nn"}">${esc(c.name)}</span><span class="t">${esc(shortType(c.dataType))}</span></div>`;
    }
    const hidden = t.columns.length - cols.length;
    if (hidden) html += `<div class="more">+ ${hidden} more column${hidden > 1 ? "s" : ""}</div>`;
    n.innerHTML = html + '<div class="pad"></div>';
    const s = sizeOf(t);
    n.style.width = s.w + "px";
    const p = pos.get(t.name);
    n.style.transform = `translate(${p.x}px, ${p.y}px)`;
    n.style.left = n.style.top = "0";
    if (old) old.replaceWith(n);
    else world.appendChild(n);
    nodes.set(t.name, n);
    wireNode(n, t);
  }

  function rowY(t, col) {
    const cols = visibleColumns(t);
    const i = cols.findIndex((c) => c.name === col);
    return i < 0 ? HEAD / 2 : HEAD + i * ROW + ROW / 2;
  }

  function drawEdges() {
    let out = "";
    for (const e of edges) {
      const a = byName.get(e.from);
      const b = byName.get(e.to);
      const pa = pos.get(e.from);
      const pb = pos.get(e.to);
      const wa = nodes.get(e.from).offsetWidth;
      const wb = nodes.get(e.to).offsetWidth;
      const ya = pa.y + rowY(a, e.fk.columns[0]);
      const yb = pb.y + rowY(b, e.fk.refColumns[0]);
      const hl = selected && (e.from === selected || e.to === selected) ? ' class="hl"' : "";
      let d;
      if (e.from === e.to) {
        const x = pa.x + wa;
        d = `M${x} ${ya} C${x + 60} ${ya}, ${x + 60} ${yb}, ${x} ${yb}`;
        d += crow(x, ya, 1) + bar(x, yb, 1);
      } else {
        const right = pb.x + wb / 2 > pa.x + wa / 2;
        const xa = right ? pa.x + wa : pa.x;
        const xb = right ? pb.x : pb.x + wb;
        const dir = right ? 1 : -1;
        const bend = Math.max(50, Math.abs(xb - xa) / 2);
        d = `M${xa} ${ya} C${xa + dir * bend} ${ya}, ${xb - dir * bend} ${yb}, ${xb} ${yb}`;
        d += crow(xa, ya, dir) + bar(xb, yb, -dir);
      }
      out += `<path${hl} d="${d}"/>`;
    }
    svg.innerHTML = out;
  }
  // "many" end: crow's foot pointing at the table
  const crow = (x, y, dir) => ` M${x + dir * 12} ${y} L${x} ${y - 6} M${x + dir * 12} ${y} L${x} ${y + 6} M${x + dir * 12} ${y} L${x} ${y}`;
  // "one" end: a bar across the line
  const bar = (x, y, dir) => ` M${x + dir * 9} ${y - 6} L${x + dir * 9} ${y + 6}`;

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    viewport.style.backgroundSize = `${22 * view.k}px ${22 * view.k}px`;
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  }

  function bounds() {
    let x1 = Infinity,
      y1 = Infinity,
      x2 = -Infinity,
      y2 = -Infinity;
    for (const [name, p] of pos) {
      const n = nodes.get(name);
      x1 = Math.min(x1, p.x);
      y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x + n.offsetWidth);
      y2 = Math.max(y2, p.y + n.offsetHeight);
    }
    return { x1, y1, x2, y2 };
  }

  function fit() {
    if (!pos.size) return;
    const b = bounds();
    const W = viewport.clientWidth;
    const H = viewport.clientHeight;
    const k = Math.min(1, (W - 80) / (b.x2 - b.x1), (H - 80) / (b.y2 - b.y1));
    view = { k, x: (W - (b.x2 - b.x1) * k) / 2 - b.x1 * k, y: (H - (b.y2 - b.y1) * k) / 2 - b.y1 * k };
    applyView();
  }

  function zoomAt(f, cx, cy) {
    const k = Math.min(2.5, Math.max(0.08, view.k * f));
    view.x = cx - ((cx - view.x) * k) / view.k;
    view.y = cy - ((cy - view.y) * k) / view.k;
    view.k = k;
    applyView();
  }

  function center(name) {
    const p = pos.get(name);
    const n = nodes.get(name);
    if (!p || !n) return;
    if (view.k < 0.7) view.k = 0.9;
    view.x = viewport.clientWidth / 2 - (p.x + n.offsetWidth / 2) * view.k;
    view.y = viewport.clientHeight / 2 - (p.y + n.offsetHeight / 2) * view.k;
    applyView();
  }

  // ---- selection and details

  function select(name) {
    selected = name;
    const related = new Set([name]);
    if (name) for (const e of edges) if (e.from === name || e.to === name) related.add(e.from === name ? e.to : e.from);
    world.classList.toggle("focus", !!name);
    for (const [n, node] of nodes) {
      node.classList.toggle("sel", n === name);
      node.classList.toggle("hl", related.has(n));
    }
    drawEdges();
    if (!name) {
      details.classList.remove("open");
      return;
    }
    details.innerHTML = '<button class="btn close" title="Close (Esc)">✕</button>' + docHtml(byName.get(name));
    details.classList.add("open");
    details.querySelector(".close").onclick = () => select(null);
    wireLinks(details);
  }

  function docHtml(t) {
    let h = `<div class="doc" id="doc-${esc(t.name)}"><h2>${esc(t.name)}<span class="kind">${t.kind}</span></h2>`;
    if (t.comment) h += `<p class="comment">${esc(t.comment)}</p>`;
    const notes = t.columns.some((c) => c.comment);
    h += `<h3>Columns</h3><table><tr><th>Name</th><th>Type</th><th>Null</th><th>Default</th>${notes ? "<th>Comment</th>" : ""}</tr>`;
    for (const c of t.columns) {
      const k = c.primaryKey ? '<span class="k pk">PK</span>' : t.fkCols.has(c.name) ? '<span class="k fk">FK</span>' : "";
      h += `<tr><td>${k}${esc(c.name)}</td><td class="mono">${esc(shortType(c.dataType))}</td><td>${c.nullable ? "yes" : '<span class="muted">no</span>'}</td><td class="mono">${esc(c.default ?? "")}</td>${notes ? `<td>${esc(c.comment ?? "")}</td>` : ""}</tr>`;
    }
    h += "</table>";
    if (t.foreignKeys.length) {
      h += "<h3>References</h3><ul>";
      for (const f of t.foreignKeys) {
        const target = f.refSchema === M.schema && byName.has(f.refTable) ? `<a data-go="${esc(f.refTable)}">${esc(f.refTable)}</a>` : esc(`${f.refSchema}.${f.refTable}`);
        h += `<li><code>${esc(f.columns.join(", "))}</code> → ${target} <code>(${esc(f.refColumns.join(", "))})</code> <span class="muted">on delete ${esc(f.onDelete.toLowerCase())}</span></li>`;
      }
      h += "</ul>";
    }
    const by = referencedBy.get(t.name) || [];
    if (by.length) {
      h += "<h3>Referenced by</h3><ul>";
      for (const e of by) h += `<li><a data-go="${esc(e.from)}">${esc(e.from)}</a> <code>(${esc(e.fk.columns.join(", "))})</code></li>`;
      h += "</ul>";
    }
    if (t.indexes.length) {
      h += "<h3>Indexes</h3><ul>";
      for (const i of t.indexes)
        h += `<li><code>${esc(i.name)}</code> <span class="muted">${i.primary ? "primary key" : i.unique ? "unique" : ""}</span> <code>(${esc(i.columns.join(", "))})</code></li>`;
      h += "</ul>";
    }
    return h + "</div>";
  }

  function wireLinks(scope) {
    scope.querySelectorAll("a[data-go]").forEach((a) => {
      a.onclick = () => {
        setView("diagram");
        center(a.dataset.go);
        select(a.dataset.go);
      };
    });
  }

  // ---- interaction

  // drag a table anywhere; a click without moving selects it
  function wireNode(n, t) {
    n.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const start = { x: e.clientX, y: e.clientY };
      const p0 = { ...pos.get(t.name) };
      let moved = false;
      const onMove = (ev) => {
        const dx = (ev.clientX - start.x) / view.k;
        const dy = (ev.clientY - start.y) / view.k;
        if (!moved && Math.hypot(dx, dy) < 3) return;
        moved = true;
        pos.set(t.name, { x: Math.round(p0.x + dx), y: Math.round(p0.y + dy) });
        n.style.transform = `translate(${pos.get(t.name).x}px, ${pos.get(t.name).y}px)`;
        drawEdges();
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (!moved) select(selected === t.name ? null : t.name);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    const start = { x: e.clientX - view.x, y: e.clientY - view.y };
    let moved = false;
    viewport.classList.add("panning");
    const onMove = (ev) => {
      moved = true;
      view.x = ev.clientX - start.x;
      view.y = ev.clientY - start.y;
      applyView();
    };
    const onUp = () => {
      viewport.classList.remove("panning");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!moved) select(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = viewport.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      else {
        view.x -= e.deltaX;
        applyView();
      }
    },
    { passive: false },
  );

  function runSearch() {
    const q = search.value.trim().toLowerCase();
    world.classList.toggle("searching", !!q);
    const hits = [];
    for (const t of tables) {
      const hit = !!q && (t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q)));
      nodes.get(t.name)?.classList.toggle("match", hit);
      if (hit) hits.push(t.name);
    }
    docs.querySelectorAll(".sections .doc").forEach((d) => (d.style.display = !q || hits.includes(d.dataset.name) ? "" : "none"));
    docs.querySelectorAll(".toc a").forEach((a) => (a.style.display = !q || hits.includes(a.dataset.name) ? "" : "none"));
    return hits;
  }
  search.addEventListener("input", runSearch);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const hits = runSearch();
      if (hits[0] && currentView === "diagram") {
        center(hits[0]);
        select(hits[0]);
      }
    }
    if (e.key === "Escape") {
      search.value = "";
      runSearch();
      search.blur();
    }
  });

  let currentView = "diagram";
  function setView(v) {
    currentView = v;
    root.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
    viewport.style.display = v === "diagram" ? "" : "none";
    docs.classList.toggle("open", v === "docs");
    root.classList.toggle("docs-mode", v === "docs");
    if (v === "docs") details.classList.remove("open");
    else if (selected) details.classList.add("open");
  }
  root.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));

  root.querySelector(".bar").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    const r = viewport.getBoundingClientRect();
    if (act === "fit") fit();
    if (act === "in") zoomAt(1.25, r.width / 2, r.height / 2);
    if (act === "out") zoomAt(0.8, r.width / 2, r.height / 2);
    if (act === "theme") document.body.classList.toggle("light");
    if (act === "keys") {
      keysOnly = !keysOnly;
      e.target.classList.toggle("on", keysOnly);
      tables.forEach(renderNode);
      if (selected) nodes.get(selected)?.classList.add("sel", "hl");
      select(selected);
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.target === search) return;
    if (e.key === "/") {
      e.preventDefault();
      search.focus();
    }
    if (e.key === "Escape") select(null);
    if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey) fit();
  });

  // ---- start

  autoLayout();
  for (const [name, p] of Object.entries(M.positions || {})) if (byName.has(name)) pos.set(name, p);
  tables.forEach(renderNode);
  drawEdges();

  docs.querySelector(".toc").innerHTML = tables.map((t) => `<a data-name="${esc(t.name)}" href="#doc-${esc(t.name)}">${esc(t.name)}</a>`).join("");
  docs.querySelector(".sections").innerHTML = tables.map((t) => docHtml(t).replace('<div class="doc"', `<div class="doc" data-name="${esc(t.name)}"`)).join("");
  wireLinks(docs);

  requestAnimationFrame(fit);
  window.addEventListener("resize", () => applyView());

  // the app reads positions back to keep the arrangement in the exported file
  window.__er = { positions: () => Object.fromEntries(pos), theme: () => (document.body.classList.contains("light") ? "light" : "dark") };
})();
