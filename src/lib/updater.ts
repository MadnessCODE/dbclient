// App updates from GitHub Releases (tauri-plugin-updater).
import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

const REPO = "https://github.com/MadnessCODE/dbclient";
/** How often a running app looks for a new version. */
const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;
const LAST_VERSION_KEY = "dbc.lastVersion";

type Status = "idle" | "checking" | "latest" | "available" | "downloading" | "error";

interface UpdaterState {
  status: Status;
  version?: string;
  notes?: string;
  error?: string;
  /** 0..1, or null when the size is unknown */
  progress: number | null;
  /** Show the update toast */
  prompt: boolean;
  /** Set on the first start after an update */
  updatedTo?: string;
  dismiss: () => void;
}

/** Version the user said "Later" to; background checks don't ask again for it. */
let dismissed: string | undefined;

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: "idle",
  progress: null,
  prompt: false,
  dismiss: () => {
    dismissed = get().version;
    set({ prompt: false });
  },
}));

export const releaseUrl = (version: string) => `${REPO}/releases/tag/v${version.replace(/^v/, "")}`;

let pending: Update | null = null;

/** `silent` checks only surface an available update, never errors or "up to date". */
export async function checkForUpdates(silent = false) {
  const st = useUpdater.getState();
  if (st.status === "checking" || st.status === "downloading") return;
  useUpdater.setState({ status: "checking", error: undefined });
  try {
    pending = await check();
    if (pending) useUpdater.setState({ status: "available", version: pending.version, notes: pending.body, prompt: !silent || pending.version !== dismissed });
    else useUpdater.setState({ status: "latest" });
  } catch (e) {
    useUpdater.setState({ status: silent ? "idle" : "error", error: String(e) });
  }
}

/** Checks shortly after start, then every few hours while the app runs. Returns a cleanup. */
export function startUpdateChecks() {
  const first = setTimeout(() => void checkForUpdates(true), 5000);
  const every = setInterval(() => void checkForUpdates(true), CHECK_EVERY_MS);
  void noteUpdatedVersion();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/** Shows "updated to ..." once after the app starts on a newer version. */
async function noteUpdatedVersion() {
  try {
    const current = await getVersion();
    const last = localStorage.getItem(LAST_VERSION_KEY);
    localStorage.setItem(LAST_VERSION_KEY, current);
    if (last && last !== current) useUpdater.setState({ updatedTo: current });
  } catch {
    // no storage or not in Tauri
  }
}

export async function installUpdate() {
  if (!pending) return;
  let total = 0;
  let done = 0;
  useUpdater.setState({ status: "downloading", progress: null, prompt: true });
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        done += ev.data.chunkLength;
        useUpdater.setState({ progress: total ? done / total : null });
      }
    });
    // Windows quits for the installer before this point; elsewhere restart manually.
    await relaunch();
  } catch (e) {
    useUpdater.setState({ status: "error", error: String(e) });
  }
}
