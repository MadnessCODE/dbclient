import { open } from "@tauri-apps/plugin-dialog";
import { Activity, FileText, House, Info, Play, Settings, type LucideIcon } from "lucide-react";
import { api, errorText } from "../lib/api";
import { useStore } from "../store";
import { cx } from "./ui";
import { TasksButton } from "./ImportJobs";

export function IconRail() {
  const view = useStore((s) => s.view);
  const setUi = useStore((s) => s.setUi);
  const newTab = useStore((s) => s.newTab);

  const openFile = async () => {
    const path = await open({ multiple: false, filters: [{ name: "SQL", extensions: ["sql", "txt"] }] });
    if (typeof path !== "string") return;
    try {
      const sql = await api.readTextFile(path);
      newTab({ sql, title: path.split(/[\\/]/).pop(), filePath: path });
    } catch (e) {
      alert(errorText(e));
    }
  };

  return (
    <nav className="flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2">
      <RailItem icon={House} label="Home" active={view === "home"} onClick={() => setUi({ view: "home" })} />
      <RailItem icon={ConnIcon} label="Connections" active={view === "workspace"} onClick={() => setUi({ view: "workspace" })} />
      <RailItem icon={Play} label="Query" onClick={() => newTab()} />
      <RailItem icon={FileText} label="Files" onClick={() => void openFile()} />
      <TasksButton />
      <RailItem icon={Activity} label="Processes" active={view === "processes"} onClick={() => setUi({ view: "processes" })} />
      <RailItem icon={Settings} label="Settings" onClick={() => setUi({ settingsOpen: true })} />
      <div className="mt-auto">
        <RailItem icon={Info} label="About" onClick={() => setUi({ aboutOpen: true })} />
      </div>
    </nav>
  );
}

function RailItem({ icon: Icon, label, active, onClick }: { icon: LucideIcon | typeof ConnIcon; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex w-[60px] flex-col items-center gap-1 rounded-lg py-2 text-[11px] transition-colors",
        active ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <Icon size={20} className={active ? "text-accent" : undefined} />
      {label}
    </button>
  );
}

/** "Database with plug" icon. */
function ConnIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 11v6c0 1.66 3.58 3 8 3" />
      <path d="M17 16v5M20 16v5M16 16h5" />
    </svg>
  );
}
