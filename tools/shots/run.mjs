// Release screenshots: runs the app's frontend on a fake backend (mock.js) in headless
// Edge/Chrome and saves the shots of scenarios.mjs to site/releases/<version>/.
//
//   npm run shots            all scenarios of the version in package.json
//   npm run shots -- 0.1.5 favorites-picker
//
// Set CHROME to the browser's path if it isn't found.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { scenarios } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const version = process.argv[2] ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const only = process.argv[3];
const list = (scenarios[version] ?? []).filter((s) => !only || s.name === only);
if (list.length === 0) {
  console.error(`No scenarios for ${version}${only ? ` named ${only}` : ""} in tools/shots/scenarios.mjs`);
  process.exit(1);
}
const outDir = join(root, "site", "releases", version);
mkdirSync(outDir, { recursive: true });

const WIDTH = 1440;
const HEIGHT = 900;
const PORT = 1441;

function findBrowser() {
  const candidates = [
    process.env.CHROME,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("No Chrome/Edge found; set CHROME to its path");
  return found;
}

/** Minimal Chrome DevTools Protocol client over the page's WebSocket. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.fail(new Error(`${p.method}: ${msg.error.message}`));
    else p.ok(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const n = ++id;
      pending.set(n, { ok, fail, method });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { send, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = await createServer({ root, configFile: join(root, "vite.config.ts"), server: { port: PORT, strictPort: true }, logLevel: "warn" });
  await server.listen();

  const profile = mkdtempSync(join(tmpdir(), "dbclient-shots-"));
  const browser = spawn(
    findBrowser(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      "--force-device-scale-factor=2",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--force-color-profile=srgb",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
    const devtoolsPort = readFileSync(portFile, "utf8").split("\n")[0].trim();
    const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    const cdp = await connect(page.webSocketDebuggerUrl);

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // exact viewport; the device scale factor stays 2 from the command line
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 0, mobile: false });
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Belgrade" });
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(join(here, "mock.js"), "utf8") });

    const js = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const mouse = (type, x, y, button = "none", clickCount = 0) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount });
    const ctx = {
      js,
      sleep,
      async load(seed) {
        // Vite may reload the page once while it optimizes dependencies: retry until the app is up
        for (let attempt = 0; attempt < 4; attempt++) {
          await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/` });
          let up = false;
          for (let i = 0; i < 150 && !up; i++) {
            await sleep(100);
            up = await js("return !!document.querySelector('nav') && document.fonts.status === 'loaded';").catch(() => false);
          }
          if (!up) continue;
          await sleep(800);
          try {
            if (seed) await js(seed);
            await sleep(600);
            return;
          } catch (e) {
            if (attempt === 3) throw e;
          }
        }
        throw new Error("the app didn't start");
      },
      /** Bounding box of the first element matching the selector (or the given text in a button). */
      async rect(selector, text) {
        return js(`
          const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
          const el = ${text ? `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))` : "els[0]"};
          if (!el) throw new Error("not found: " + ${JSON.stringify(`${selector} ${text ?? ""}`)});
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };`);
      },
      hover: async (x, y) => {
        await mouse("mouseMoved", x, y);
        await sleep(150);
      },
      async click(x, y, button = "left", clickCount = 1) {
        await mouse("mouseMoved", x, y);
        await mouse("mousePressed", x, y, button, clickCount);
        await mouse("mouseReleased", x, y, button, clickCount);
        await sleep(250);
      },
      async key(key, code = key, keyCode) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
        await sleep(120);
      },
      type: (text) => cdp.send("Input.insertText", { text }),
      /** Saves the area (CSS pixels) as <name>.png at 2x. */
      async shot(name, area) {
        const clip = {
          x: Math.max(0, Math.round(area.x)),
          y: Math.max(0, Math.round(area.y)),
          width: Math.round(Math.min(area.width, WIDTH - Math.max(0, area.x))),
          height: Math.round(Math.min(area.height, HEIGHT - Math.max(0, area.y))),
          scale: 1,
        };
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
        const file = join(outDir, `${name}.png`);
        writeFileSync(file, Buffer.from(data, "base64"));
        console.log(`  saved ${file}`);
      },
    };

    for (const s of list) {
      console.log(`${version} / ${s.name}`);
      try {
        await s.run(ctx);
      } catch (e) {
        // what the page looked like, for debugging the scenario
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
        const file = join(tmpdir(), `dbclient-shot-failed-${s.name}.png`);
        writeFileSync(file, Buffer.from(data, "base64"));
        console.error(`  failed, page saved to ${file}`);
        throw e;
      }
    }
    cdp.close();
  } finally {
    browser.kill();
    await server.close();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
