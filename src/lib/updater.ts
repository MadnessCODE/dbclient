// App updates from GitHub Releases (tauri-plugin-updater).
import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

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
  dismiss: () => void;
}

export const useUpdater = create<UpdaterState>((set) => ({
  status: "idle",
  progress: null,
  prompt: false,
  dismiss: () => set({ prompt: false }),
}));

let pending: Update | null = null;

/** `silent` checks only surface an available update, never errors or "up to date". */
export async function checkForUpdates(silent = false) {
  const st = useUpdater.getState();
  if (st.status === "checking" || st.status === "downloading") return;
  useUpdater.setState({ status: "checking", error: undefined });
  try {
    pending = await check();
    if (pending) useUpdater.setState({ status: "available", version: pending.version, notes: pending.body, prompt: true });
    else useUpdater.setState({ status: "latest" });
  } catch (e) {
    useUpdater.setState({ status: silent ? "idle" : "error", error: String(e) });
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
