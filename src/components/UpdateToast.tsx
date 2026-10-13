import { Download, PartyPopper, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { installUpdate, releaseUrl, useUpdater } from "../lib/updater";
import { Button } from "./ui";

function WhatsNew({ version }: { version: string }) {
  return (
    <button onClick={() => void openUrl(releaseUrl(version))} className="text-[12px] font-medium text-accent hover:underline">
      What's new
    </button>
  );
}

export function UpdateToast() {
  const { prompt, status, version, progress, error, dismiss, updatedTo } = useUpdater();
  if (!prompt && !updatedTo) return null;
  if (!prompt && updatedTo)
    return (
      <div className="pointer-events-auto flex animate-[tip-in_160ms_ease-out] gap-3 rounded-xl border border-ok/40 bg-raised p-3.5 shadow-2xl shadow-black/50">
        <PartyPopper size={20} className="mt-px shrink-0 text-ok" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-fg">Updated to DB Client {updatedTo}</div>
          <div className="mt-1">
            <WhatsNew version={updatedTo} />
          </div>
        </div>
        <button title="Close" onClick={() => useUpdater.setState({ updatedTo: undefined })} className="h-6 shrink-0 rounded p-0.5 text-muted hover:bg-hover hover:text-fg">
          <X size={15} />
        </button>
      </div>
    );

  const busy = status === "downloading";
  return (
    <div className="pointer-events-auto flex animate-[tip-in_160ms_ease-out] gap-3 rounded-xl border border-accent/50 bg-raised p-3.5 shadow-2xl shadow-black/50">
      <Download size={20} className="mt-px shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-fg">DB Client {version} is available</div>
        {status === "error" ? (
          <div className="mt-0.5 line-clamp-3 text-[12px] leading-snug text-err">{error}</div>
        ) : busy ? (
          <>
            <div className="mt-0.5 text-[12px] text-fg-2">Downloading… the app restarts when it's done.</div>
            {progress === null ? (
              <div className="loading-bar mt-2 h-1.5 rounded-full" />
            ) : (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-2">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            )}
          </>
        ) : (
          <div className="mt-0.5 text-[12px] text-fg-2">Install now and restart, or keep working and update later.</div>
        )}
        {!busy && (
          <div className="mt-2.5 flex items-center gap-2">
            <Button variant="primary" className="h-7" onClick={() => void installUpdate()}>
              {status === "error" ? "Retry" : "Install & restart"}
            </Button>
            <Button variant="ghost" className="h-7" onClick={dismiss}>
              Later
            </Button>
            {version && (
              <span className="ml-auto">
                <WhatsNew version={version} />
              </span>
            )}
          </div>
        )}
      </div>
      {!busy && (
        <button title="Close" onClick={dismiss} className="h-6 shrink-0 rounded p-0.5 text-muted hover:bg-hover hover:text-fg">
          <X size={15} />
        </button>
      )}
    </div>
  );
}
