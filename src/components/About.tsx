// About dialog with the author's signature and animated logo.
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import { useStore } from "../store";
import { DbIcon, Modal } from "./ui";
import { AnimatedLogo } from "./AnimatedLogo";
import { checkForUpdates, releaseUrl, useUpdater } from "../lib/updater";

export const AUTHOR = "MadnessCODE";
export const AUTHOR_URL = "https://github.com/madnesscode";

const FLOATING = ["SELECT", "JOIN", "WHERE", "{ }", "INDEX", "*", "COMMIT", "</>", "FK", "GROUP BY", "NULL", "=>"];

/** Typewriter text with a blinking cursor. */
function Typewriter({ text, delay = 0 }: { text: string; delay?: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    let i = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      timer = setInterval(() => {
        i++;
        setN(i);
        if (i >= text.length && timer) clearInterval(timer);
      }, 70);
    }, delay);
    return () => {
      clearTimeout(start);
      if (timer) clearInterval(timer);
    };
  }, [text, delay]);
  return (
    <span>
      {text.slice(0, n)}
      <span className="about-caret ml-0.5 inline-block w-[2px] self-stretch bg-[#8dc53f]">&nbsp;</span>
    </span>
  );
}

export function AboutDialog() {
  const open = useStore((s) => s.aboutOpen);
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (open) getVersion().then(setVersion, () => setVersion(""));
  }, [open]);
  if (!open) return null;
  const close = () => useStore.getState().setUi({ aboutOpen: false });

  return (
    <Modal title="About" onClose={close} width={440}>
      <div className="relative overflow-hidden">
        {/* floating SQL keywords */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {FLOATING.map((w, i) => (
            <span
              key={w}
              className="about-float absolute bottom-0 font-mono text-[11px] text-accent/40"
              style={{ left: `${6 + ((i * 83) % 88)}%`, animationDelay: `${(i * 0.9) % 7}s`, animationDuration: `${7 + (i % 4)}s` }}
            >
              {w}
            </span>
          ))}
        </div>

        <div className="relative flex flex-col items-center gap-3 px-6 pt-6 pb-6 text-center">
          <div className="about-pop">
            <AnimatedLogo size={150} />
          </div>
          <div className="about-rise" style={{ animationDelay: "250ms" }}>
            <div className="text-[11px] tracking-[0.2em] text-muted uppercase">Created by</div>
            <div className="mt-1 flex h-8 items-center justify-center text-[24px] font-bold tracking-tight">
              <Typewriter text={AUTHOR} delay={450} />
            </div>
            <p className="mt-1 text-[11px] text-muted">psst, click the logo</p>
          </div>

          <div className="about-rise mt-2 w-full rounded-xl border border-line bg-panel-2/80 px-4 py-4 backdrop-blur-sm" style={{ animationDelay: "500ms" }}>
            <div className="flex items-center justify-center gap-2.5">
              <span className="about-bob">
                <DbIcon kind="postgres" size={26} />
              </span>
              <span className="text-[18px] font-semibold">DB Client</span>
              <span className="about-bob" style={{ animationDelay: "600ms" }}>
                <DbIcon kind="mysql" size={26} />
              </span>
            </div>
            <p className="mt-1 flex items-center justify-center gap-1.5 text-[12px] text-muted">
              {version ? `Version ${version}` : " "}
              <span className="rounded border border-warn/50 bg-warn/15 px-1.5 py-px text-[10px] font-bold tracking-wider text-warn">BETA</span>
            </p>
            <UpdateCheck />
            {version && (
              <button onClick={() => void openUrl(releaseUrl(version))} className="mt-0.5 text-[11.5px] text-accent hover:underline">
                What's new in {version}
              </button>
            )}
            <p className="mx-auto mt-2 max-w-[300px] text-[13px] text-fg-2">Fast desktop client for PostgreSQL and MySQL. Built with Rust and Tauri.</p>
            <button onClick={() => void openUrl(AUTHOR_URL)} className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-accent hover:underline">
              <GithubMark /> github.com/madnesscode <ExternalLink size={12} />
            </button>
          </div>

          <p className="about-rise text-[11px] text-muted" style={{ animationDelay: "700ms" }}>
            © 2026 {AUTHOR}. All rights reserved.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function UpdateCheck() {
  const { status, version, error } = useUpdater();
  const text =
    status === "checking"
      ? "Checking for updates…"
      : status === "latest"
        ? "You're on the latest version"
        : status === "available" || status === "downloading"
          ? `Version ${version} is available`
          : status === "error"
            ? "Update check failed"
            : null;
  return (
    <p className="mt-1 text-[11.5px]" title={status === "error" ? error : undefined}>
      {text && <span className={status === "error" ? "text-err" : status === "available" ? "text-accent" : "text-muted"}>{text} · </span>}
      {status === "available" ? (
        <button onClick={() => useUpdater.setState({ prompt: true })} className="text-accent hover:underline">
          Install
        </button>
      ) : (
        <button disabled={status === "checking" || status === "downloading"} onClick={() => void checkForUpdates()} className="text-accent hover:underline disabled:opacity-50">
          Check for updates
        </button>
      )}
    </p>
  );
}

/** GitHub logo (Simple Icons, CC0). */
function GithubMark() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}
