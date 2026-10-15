// What's new: renders CHANGELOG.md (copied next to this page when the site deploys).
// Format: "## <version>" per release, "> summary", "### Group", "#### Feature" with paragraphs,
// images, "**How to use it**" + numbered steps; smaller changes are "- " bullets.

const SITE = "https://madnesscode.github.io/dbclient/";
const SOURCES = ["CHANGELOG.md", "../CHANGELOG.md", "https://raw.githubusercontent.com/MadnessCODE/dbclient/main/CHANGELOG.md"];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Screenshots link to the live site; served from elsewhere (local preview), load them relatively. */
const assetUrl = (url) => (url.startsWith(SITE) && !location.href.startsWith(SITE) ? url.slice(SITE.length) : url);

/** Inline markdown: `code`, **bold**, *italic*, [links](url). */
function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<b class="ui">$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const c = codes[+i];
    // keyboard shortcuts read better as keys
    return /^(Ctrl|Shift|Alt|Cmd|⌘|Enter|Esc|F\d+)([+ ].*)?$/.test(c) ? c.split("+").map((k) => `<kbd>${k}</kbd>`).join("<i>+</i>") : `<code>${c}</code>`;
  });
}

/** Parses the changelog into releases → groups → items (feature, bullet or paragraph). */
function parse(md) {
  const releases = [];
  let rel = null;
  let group = null;
  let feature = null;
  let block = null; // current multi-line block: { kind, lines }

  const flush = () => {
    if (!block) return;
    const text = block.lines.join(" ").trim();
    const target = feature ? feature.blocks : group ? group.items : rel?.intro;
    if (block.kind === "quote" && rel && !group) rel.summary = text;
    else if (block.kind === "li" && !feature && group) group.items.push({ type: "bullet", text });
    else if (target) target.push({ type: block.kind === "li" ? "bullet" : block.kind, text, n: block.n });
    block = null;
  };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^## +(\S+)(?:\s+[·—-]\s+(.+))?$/.exec(line))) {
      flush();
      rel = { version: m[1], date: m[2] ?? null, summary: "", intro: [], groups: [] };
      releases.push(rel);
      group = feature = null;
    } else if (!rel) {
      continue;
    } else if ((m = /^### +(.+)$/.exec(line))) {
      flush();
      group = { title: m[1], items: [] };
      rel.groups.push(group);
      feature = null;
    } else if ((m = /^#### +(.+)$/.exec(line))) {
      flush();
      if (!group) rel.groups.push((group = { title: "New", items: [] }));
      feature = { type: "feature", title: m[1], blocks: [] };
      group.items.push(feature);
    } else if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line))) {
      flush();
      (feature ? feature.blocks : group ? group.items : rel.intro).push({ type: "image", alt: m[1], src: m[2] });
    } else if ((m = /^> ?(.*)$/.exec(line))) {
      if (block?.kind !== "quote") flush(), (block = { kind: "quote", lines: [] });
      block.lines.push(m[1]);
    } else if ((m = /^- +(.*)$/.exec(line))) {
      flush();
      block = { kind: "li", lines: [m[1]] };
    } else if ((m = /^(\d+)\. +(.*)$/.exec(line))) {
      flush();
      block = { kind: "step", n: +m[1], lines: [m[2]] };
    } else if (!line.trim()) {
      flush();
    } else if (block && (/^\s+/.test(raw) || block.kind === "p" || block.kind === "quote")) {
      block.lines.push(line.trim());
    } else {
      flush();
      block = { kind: "p", lines: [line.trim()] };
    }
  }
  flush();
  return releases;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const GROUP_STYLE = { new: "new", fixed: "fixed", improved: "improved", changed: "improved", import: "import", export: "import" };

function renderBlocks(blocks) {
  let html = "";
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "image") {
      // screenshots in a row sit side by side on wide screens
      const shots = [b];
      while (blocks[i + 1]?.type === "image") shots.push(blocks[++i]);
      const figs = shots
        .map((x) => `<figure class="shot"><button class="shot-open" aria-label="Enlarge"><img src="${esc(assetUrl(x.src))}" alt="${esc(x.alt)}" loading="lazy" /></button>${x.alt ? `<figcaption>${inline(x.alt)}</figcaption>` : ""}</figure>`)
        .join("");
      html += shots.length > 1 ? `<div class="shots">${figs}</div>` : figs;
    } else if (b.type === "p" && /^\*\*How to[^*]*\*\*:?$/.test(b.text)) {
      const steps = [];
      while (blocks[i + 1]?.type === "step") steps.push(blocks[++i]);
      html += `<div class="howto"><div class="howto-title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>${inline(b.text.replace(/\*\*/g, "").replace(/:$/, ""))}</div><ol>${steps.map((s) => `<li>${inline(s.text)}</li>`).join("")}</ol></div>`;
    } else if (b.type === "step") {
      const steps = [b];
      while (blocks[i + 1]?.type === "step") steps.push(blocks[++i]);
      html += `<ol class="steps">${steps.map((s) => `<li>${inline(s.text)}</li>`).join("")}</ol>`;
    } else if (b.type === "bullet") {
      const items = [b];
      while (blocks[i + 1]?.type === "bullet") items.push(blocks[++i]);
      html += `<ul class="plain">${items.map((s) => `<li>${inline(s.text)}</li>`).join("")}</ul>`;
    } else {
      html += `<p>${inline(b.text)}</p>`;
    }
  }
  return html;
}

function renderFeature(f) {
  // the first screenshot goes next to the description, the rest after the steps
  const firstImg = f.blocks.findIndex((b) => b.type === "image");
  const intro = f.blocks.slice(0, firstImg < 0 ? f.blocks.length : firstImg);
  const rest = firstImg < 0 ? [] : f.blocks.slice(firstImg);
  return `<article class="feature" id="${slug(f.title)}">
    <h3>${inline(f.title)}</h3>
    ${renderBlocks(intro)}
    ${renderBlocks(rest)}
  </article>`;
}

function renderBullet(text) {
  // "**Title.** rest" → title on its own line; "**Stop** shows …" stays one sentence
  const m = /^\*\*(.+?)\*\*([.:]?)\s*(.*)$/.exec(text);
  const titled = m && (/[.:]$/.test(m[1]) || m[2] || !m[3]);
  return titled
    ? `<li><span class="b-title">${inline(m[1].replace(/[.:]$/, ""))}</span>${m[3] ? `<span class="b-text">${inline(m[3])}</span>` : ""}</li>`
    : `<li><span class="b-text">${inline(text)}</span></li>`;
}

function renderRelease(r, i) {
  const groups = r.groups
    .map((g) => {
      const kind = GROUP_STYLE[g.title.toLowerCase()] ?? "improved";
      const features = g.items.filter((x) => x.type === "feature");
      const bullets = g.items.filter((x) => x.type === "bullet");
      const other = g.items.filter((x) => x.type !== "feature" && x.type !== "bullet");
      return `<div class="group">
        <h4 class="tag ${kind}">${esc(g.title)}</h4>
        ${features.map(renderFeature).join("")}
        ${renderBlocks(other)}
        ${bullets.length ? `<ul class="changes">${bullets.map((b) => renderBullet(b.text)).join("")}</ul>` : ""}
      </div>`;
    })
    .join("");
  return `<section class="release${i === 0 ? " latest" : ""}" id="v${esc(r.version)}">
    <header class="rel-head">
      <a class="rel-version" href="#v${esc(r.version)}">v${esc(r.version)}</a>
      ${i === 0 ? '<span class="rel-badge">Latest</span>' : ""}
      ${r.date ? `<time>${esc(r.date)}</time>` : ""}
    </header>
    <div class="rel-body">
      ${r.summary ? `<p class="rel-summary">${inline(r.summary)}</p>` : ""}
      ${renderBlocks(r.intro)}
      ${groups}
    </div>
  </section>`;
}

async function load() {
  for (const src of SOURCES) {
    try {
      const res = await fetch(src, { cache: "no-cache" });
      if (res.ok) return await res.text();
    } catch {
      // try the next one
    }
  }
  throw new Error("CHANGELOG.md not found");
}

function lightbox() {
  const box = document.getElementById("lightbox");
  const img = box.querySelector("img");
  const cap = box.querySelector("figcaption");
  const close = () => (box.hidden = true);
  document.addEventListener("click", (e) => {
    const open = e.target.closest(".shot-open");
    if (open) {
      const src = open.querySelector("img");
      img.src = src.src;
      img.alt = src.alt;
      cap.textContent = src.alt;
      box.hidden = false;
    } else if (!box.hidden && !e.target.closest(".lightbox img")) close();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
}

async function main() {
  const root = document.getElementById("releases");
  try {
    const releases = parse(await load());
    root.innerHTML = releases.map(renderRelease).join("");
    // screenshots are taken at 2x: show them at their real size (still shrinking to fit)
    for (const img of root.querySelectorAll(".shot img")) {
      const fit = () => (img.style.width = `${img.naturalWidth / 2}px`);
      if (img.complete && img.naturalWidth) fit();
      else img.addEventListener("load", fit, { once: true });
    }
    document.getElementById("versions").innerHTML = releases
      .map((r, i) => `<a href="#v${esc(r.version)}"${i === 0 ? ' class="latest"' : ""}>v${esc(r.version)}</a>`)
      .join("");
    // jump to the version from the link (the app opens #v<version>) once the content exists
    const target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) {
      target.classList.add("focus");
      requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
    }
  } catch (e) {
    root.innerHTML = `<p class="wn-loading">Couldn't load the release notes. See <a href="https://github.com/MadnessCODE/dbclient/releases">all releases on GitHub</a>.</p>`;
    console.error(e);
  }
  lightbox();
}

main();
