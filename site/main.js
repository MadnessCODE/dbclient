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
