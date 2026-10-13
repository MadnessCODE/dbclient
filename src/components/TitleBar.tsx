import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Database, Minus, Moon, Search, Settings, Square, Sun, X } from "lucide-react";
import { useStore } from "../store";
import { cx, IconButton, isMac, MOD } from "./ui";

// lazy so the UI also runs in a plain browser
const isTauri = "__TAURI_INTERNALS__" in window;
const appWindow = () => getCurrentWindow();

export function TitleBar() {
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const setUi = useStore((s) => s.setUi);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    void appWindow().isMaximized().then(setMaximized);
    const un = appWindow().onResized(() => void appWindow().isMaximized().then(setMaximized));
    return () => void un.then((f) => f());
  }, []);

  return (
    <header data-tauri-drag-region className={cx("flex h-14 shrink-0 items-center border-b border-line bg-panel", isMac ? "pl-[84px]" : "pl-4")}>
      <div data-tauri-drag-region className="flex w-[300px] items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft">
          <Database size={20} className="text-accent" />
        </div>
        <div data-tauri-drag-region className="leading-tight">
          <div className="text-[15px] font-semibold">DB Client</div>
          <div className="text-[11px] text-muted">Connect • Query • Explore</div>
        </div>
      </div>

      <div data-tauri-drag-region className="flex flex-1 justify-center px-4">
        <button
          onClick={() => setUi({ paletteOpen: true })}
          className="flex h-9 w-full max-w-[540px] items-center gap-2.5 rounded-lg border border-line-strong bg-bg/50 px-3 text-left text-muted transition-colors hover:border-accent/60"
        >
          <Search size={15} />
          <span className="flex-1 text-[13px]">Search tables, columns, SQL...</span>
          <kbd className="rounded border border-line-strong px-1.5 py-0.5 font-sans text-[11px]">{MOD} + K</kbd>
        </button>
      </div>

      <div className={cx("flex items-center gap-2", isMac ? "pr-4" : "pr-2")}>
        <IconButton title="Settings" onClick={() => setUi({ settingsOpen: true })}>
          <Settings size={17} />
        </IconButton>
        <div className="flex items-center rounded-lg border border-line-strong p-0.5">
          <IconButton title="Light theme" active={theme === "light"} onClick={() => theme !== "light" && toggleTheme()}>
            <Sun size={15} />
          </IconButton>
          <IconButton title="Dark theme" active={theme === "dark"} onClick={() => theme !== "dark" && toggleTheme()}>
            <Moon size={15} />
          </IconButton>
        </div>
      </div>

      {!isMac && (
        <div className="flex h-full items-stretch">
          <WindowButton title="Minimize" onClick={() => void appWindow().minimize()}>
            <Minus size={16} />
          </WindowButton>
          <WindowButton title={maximized ? "Restore" : "Maximize"} onClick={() => void appWindow().toggleMaximize()}>
            {maximized ? <Copy size={13} className="-scale-x-100" /> : <Square size={13} />}
          </WindowButton>
          <WindowButton title="Close" danger onClick={() => void appWindow().close()}>
            <X size={17} />
          </WindowButton>
        </div>
      )}
    </header>
  );
}

function WindowButton({ title, danger, onClick, children }: { title: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cx("flex w-12 items-center justify-center text-fg-2 transition-colors", danger ? "hover:bg-[#e81123] hover:text-white" : "hover:bg-hover")}
    >
      {children}
    </button>
  );
}
