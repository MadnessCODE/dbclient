// Prepares the website for publishing, for readers that don't run JavaScript (search engines,
// AI crawlers): renders the release notes into whats-new.html with the page's own renderer, puts
// the latest version into the home page's structured data, and writes llms-full.txt and
// sitemap.xml. Runs on a copy of site/ in the Pages workflow; nothing here is committed.
//
//   node tools/site/build.mjs [site dir]     (default: site, with CHANGELOG.md next to it or one level up)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SITE = "https://madnesscode.github.io/dbclient/";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dir = resolve(process.argv[2] ?? join(root, "site"));
const changelogPath = [join(dir, "CHANGELOG.md"), join(root, "CHANGELOG.md")].find(existsSync);
if (!changelogPath) throw new Error("CHANGELOG.md not found");
const changelog = readFileSync(changelogPath, "utf8");
const read = (f) => readFileSync(join(dir, f), "utf8");
const write = (f, text) => {
  writeFileSync(join(dir, f), text);
  console.log(`  wrote ${f}`);
};

// the What's new page's own parser and renderer, run without a browser
const ctx = { location: { href: SITE }, console };
vm.createContext(ctx);
vm.runInContext(read("whats-new.js"), ctx);
const { parse, renderRelease, versionLinks } = ctx.WN;
const releases = parse(changelog);
if (!releases.length) throw new Error("no releases in CHANGELOG.md");
const latest = releases[0].version;
const today = new Date().toISOString().slice(0, 10);

/** Replaces exactly one occurrence, so a changed page fails the build instead of shipping stale. */
function swap(text, from, to, file) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`${file}: expected one ${JSON.stringify(from.slice(0, 60))}, found ${n}`);
  return text.replace(from, to);
}

// What's new: the release notes in the HTML itself
let wn = read("whats-new.html");
wn = swap(wn, '<nav class="wn-versions" id="versions" aria-label="Versions"></nav>', `<nav class="wn-versions" id="versions" aria-label="Versions">${versionLinks(releases)}</nav>`, "whats-new.html");
wn = swap(
  wn,
  '<div id="releases" class="wn-releases">\n        <p class="wn-loading">Loading release notes…</p>\n      </div>',
  `<div id="releases" class="wn-releases" data-ready>\n${releases.map(renderRelease).join("\n")}\n      </div>`,
  "whats-new.html",
);
write("whats-new.html", wn);

// Home: current version in the structured data
let home = read("index.html");
home = swap(home, '"softwareVersion": "latest"', `"softwareVersion": "${latest}"`, "index.html");
home = swap(home, '"dateModified": "today"', `"dateModified": "${today}"`, "index.html");
write("index.html", home);

// llms-full.txt: the short llms.txt plus every release note as plain markdown
const notes = changelog.slice(changelog.indexOf("\n## ") + 1).replace(/\]\(\.\.?\//g, `](${SITE}`);
write("llms-full.txt", `${read("llms.txt").trimEnd()}\n\nLatest version: ${latest}\n\n# Release notes\n\n${notes}`);

const pages = [
  ["", "weekly", "1.0"],
  ["whats-new.html", "weekly", "0.8"],
  ["llms.txt", "monthly", "0.3"],
  ["llms-full.txt", "weekly", "0.3"],
];
write(
  "sitemap.xml",
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
    .map(([p, freq, prio]) => `  <url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod><changefreq>${freq}</changefreq><priority>${prio}</priority></url>`)
    .join("\n")}\n</urlset>\n`,
);
console.log(`site ready: ${releases.length} releases, latest ${latest}`);
