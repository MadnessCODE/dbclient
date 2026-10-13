// Home page: animated hero and connection cards.
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, FolderPlus, GitFork, KeyRound, Link2, Plus, ShieldAlert, Sparkles, TableProperties, Zap, type LucideIcon } from "lucide-react";
import { type ConnectionConfig, type Project } from "../lib/api";
import { connColor, tint } from "../lib/connStyle";
import { useStore } from "../store";
import { ProjectIcon } from "./ProjectIcon";
import { cx, DbIcon, EnvBadge } from "./ui";

const TAGLINES = ["Query at the speed of Rust.", "PostgreSQL & MySQL. One home.", "Safe for production. Fast everywhere.", "Your data, one click away."];

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Zap, title: "Native speed", text: "Rust core, streams 10k rows in milliseconds" },
  { icon: KeyRound, title: "SSH tunnels", text: "Reach private databases securely" },
  { icon: TableProperties, title: "Structure editor", text: "Columns, indexes, FKs with ALTER preview" },
  { icon: Link2, title: "FK navigation", text: "Jump to related rows in one click" },
  { icon: ShieldAlert, title: "Production guard", text: "Confirms every write on PROD" },
  { icon: GitFork, title: "Projects", text: "Group connections the way you work" },
];

const FLOATING = ["SELECT", "JOIN", "WHERE", "GROUP BY", "INDEX", "COMMIT", "EXPLAIN", "FK", "{ }", "*", "ORDER BY", "NULL"];

export function HomePage() {
  const connections = useStore((s) => s.connections);
  const projects = useStore((s) => s.projects);
  const history = useStore((s) => s.history);

  const groups = useMemo(() => {
    const sorted = [...connections].sort((a, b) => a.name.localeCompare(b.name));
    const known = new Set(projects.map((p) => p.id));
    const out: { project: Project | null; items: ConnectionConfig[] }[] = [...projects]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ project: p, items: sorted.filter((c) => c.projectId === p.id) }))
      .filter((g) => g.items.length > 0);
    const loose = sorted.filter((c) => !c.projectId || !known.has(c.projectId));
    if (loose.length) out.push({ project: null, items: loose });
    return out;
  }, [connections, projects]);

  let cardIndex = 0;

  return (
    <main className="home-page relative min-w-0 flex-1 overflow-y-auto bg-bg">
      <Hero stats={{ connections: connections.length, projects: projects.length, queries: history.length }} />

      <section className="relative mx-auto max-w-[1180px] px-8 pt-9 pb-16">
        <div className="mb-5 flex items-end justify-between">
          <div>
            <h2 className="text-[20px] font-semibold">Your connections</h2>
            <p className="text-[13px] text-muted">One click connects and opens a new query.</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => useStore.getState().setUi({ projectDialog: { open: true } })}
              className="flex items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-[13px] text-fg-2 hover:bg-hover hover:text-fg"
            >
              <FolderPlus size={15} /> New project
            </button>
            <button
              onClick={() => useStore.getState().setUi({ connDialog: { open: true } })}
              className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:bg-accent-hover"
            >
              <Plus size={15} /> New connection
            </button>
          </div>
        </div>

        {groups.length === 0 && <EmptyConnections />}

        {groups.map((g) => (
          <div key={g.project?.id ?? "loose"} className="mb-8">
            <div className="mb-3 flex items-center gap-2.5">
              {g.project ? <ProjectIcon project={g.project} size={24} /> : null}
              <h3 className="text-[14px] font-semibold tracking-wide text-fg-2">{g.project ? g.project.name : groups.length > 1 ? "No project" : "All connections"}</h3>
              <span className="text-[12px] text-muted">{g.items.length}</span>
              <div className="ml-2 h-px flex-1 bg-gradient-to-r from-line-strong to-transparent" />
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5">
              {g.items.map((c) => (
                <ConnectionCard key={c.id} cfg={c} index={cardIndex++} />
              ))}
            </div>
          </div>
        ))}

      </section>
    </main>
  );
}


function Hero({ stats }: { stats: { connections: number; projects: number; queries: number } }) {
  return (
    <section className="relative overflow-hidden border-b border-line">
      {/* animated background */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="home-grid absolute inset-x-[-20%] bottom-[-40%] h-[90%]" />
        <div className="home-blob home-blob-1" />
        <div className="home-blob home-blob-2" />
        <div className="home-blob home-blob-3" />
        {FLOATING.map((w, i) => (
          <span
            key={w}
            className="home-float absolute font-mono text-[12px] text-accent/30"
            style={{ left: `${4 + ((i * 79) % 92)}%`, animationDelay: `${(i * 1.3) % 9}s`, animationDuration: `${9 + (i % 5) * 2}s` }}
          >
            {w}
          </span>
        ))}
      </div>

      <div className="relative mx-auto flex max-w-[1180px] items-center gap-10 px-8 pt-14 pb-12">
        <div className="min-w-0 flex-1">
          <div className="home-rise mb-4 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent-soft px-3 py-1 text-[12px] text-accent">
            <Sparkles size={13} /> Native database client · Rust + Tauri
          </div>
          <h1 className="home-rise home-title text-[64px] leading-[1.02] font-extrabold tracking-tight" style={{ animationDelay: "80ms" }}>
            DB Client
          </h1>
          <div className="home-rise mt-3 h-9 text-[24px] font-medium text-fg-2" style={{ animationDelay: "160ms" }}>
            <RotatingTagline />
          </div>
          <p className="home-rise mt-3 max-w-[520px] text-[14px] leading-relaxed text-muted" style={{ animationDelay: "240ms" }}>
            Connect, query and explore PostgreSQL and MySQL with a lightning fast native app. Tunnels, structure editing and a production safety net included.
          </p>

          <div className="home-rise mt-7 flex gap-8" style={{ animationDelay: "320ms" }}>
            <Stat value={stats.connections} label="connections" />
            <Stat value={stats.projects} label="projects" />
            <Stat value={stats.queries} label="queries run" />
          </div>
        </div>

        <Orbit />
      </div>

      <div className="relative mx-auto grid max-w-[1180px] grid-cols-3 gap-3 px-8 pb-10 xl:grid-cols-6">
        {FEATURES.map(({ icon: Icon, title, text }, i) => (
          <div key={title} className="home-feature rounded-xl border border-line bg-panel/70 p-3.5 backdrop-blur-sm" style={{ animationDelay: `${400 + i * 90}ms` }}>
            <Icon size={18} className="mb-2 text-accent" />
            <div className="text-[13px] font-semibold">{title}</div>
            <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{text}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Counts up from 0. */
function Stat({ value, label }: { value: number; label: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const dur = 900;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      setShown(Math.round(value * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <div>
      <div className="text-[30px] leading-none font-bold tabular-nums">{shown}</div>
      <div className="mt-1 text-[11px] tracking-wider text-muted uppercase">{label}</div>
    </div>
  );
}

/** Rotating taglines with a typewriter effect. */
function RotatingTagline() {
  const [i, setI] = useState(0);
  const [n, setN] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const text = TAGLINES[i];

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    if (!deleting && n < text.length) t = setTimeout(() => setN(n + 1), 45);
    else if (!deleting) t = setTimeout(() => setDeleting(true), 2200);
    else if (n > 0) t = setTimeout(() => setN(n - 1), 22);
    else {
      setDeleting(false);
      setI((i + 1) % TAGLINES.length);
    }
    return () => clearTimeout(t);
  }, [n, deleting, text, i]);

  return (
    <span>
      {text.slice(0, n)}
      <span className="about-caret ml-0.5 inline-block h-[1em] w-[3px] translate-y-[3px] bg-accent" />
    </span>
  );
}

/** Elephant and dolphin orbiting a glowing core. */
function Orbit() {
  return (
    <div className="home-rise relative hidden h-[260px] w-[260px] shrink-0 lg:block" style={{ animationDelay: "200ms" }}>
      <div className="absolute inset-0 rounded-full border border-accent/15" />
      <div className="absolute inset-8 rounded-full border border-dashed border-accent/20" />
      <div className="home-core absolute top-1/2 left-1/2 h-24 w-24 rounded-full" />
      <svg className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.6">
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
      </svg>
      <div className="home-orbit absolute inset-0">
        <span className="home-counter absolute -top-5 left-1/2 -ml-6 flex h-12 w-12 items-center justify-center rounded-2xl border border-line-strong bg-panel shadow-xl">
          <DbIcon kind="postgres" size={30} />
        </span>
        <span className="home-counter absolute -bottom-5 left-1/2 -ml-6 flex h-12 w-12 items-center justify-center rounded-2xl border border-line-strong bg-panel shadow-xl">
          <DbIcon kind="mysql" size={30} />
        </span>
      </div>
    </div>
  );
}


function ConnectionCard({ cfg, index }: { cfg: ConnectionConfig; index: number }) {
  const state = useStore((s) => s.conn[cfg.id]);
  const status = state?.status ?? "idle";
  const color = connColor(cfg) ?? (cfg.kind === "postgres" ? "#3b7ddd" : "#5fa8d3");

  const open = async () => {
    const st = useStore.getState();
    st.selectConnection(cfg.id);
    // open the tab right away; connect in the background
    st.newTab({ connId: cfg.id });
    if (status !== "connected") await st.connectTo(cfg.id);
  };

  return (
    <button
      onClick={() => void open()}
      onContextMenu={(e) => {
        e.preventDefault();
        useStore.getState().setUi({ connDialog: { open: true, editing: cfg } });
      }}
      style={{ animationDelay: `${150 + index * 60}ms`, ["--card" as string]: color }}
      className="home-card group relative overflow-hidden rounded-2xl border border-line bg-panel p-4 text-left"
      title="Click to connect and open a query · right-click to edit"
    >
      <div className="absolute inset-x-0 top-0 h-[3px]" style={{ background: `linear-gradient(90deg, ${color}, ${tint(color, 0.1)})` }} />
      <div className="pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100" style={{ background: tint(color, 0.35) }} />

      <div className="relative flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-panel-2 transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6">
          <DbIcon kind={cfg.kind} size={26} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold text-fg">{cfg.name}</span>
            <EnvBadge cfg={cfg} />
          </div>
          <div className="truncate text-[12px] text-muted">
            {cfg.host}:{cfg.port}
            {cfg.ssh?.enabled ? ` · SSH ${cfg.ssh.host}` : ""}
          </div>
        </div>
      </div>

      <div className="relative mt-4 flex items-center justify-between text-[12px]">
        <span className="flex items-center gap-1.5 text-muted">
          <span
            className={cx(
              "h-2 w-2 rounded-full",
              status === "connected" && "bg-ok shadow-[0_0_8px_var(--ok)]",
              status === "connecting" && "animate-pulse bg-warn",
              status === "error" && "bg-err",
              status === "idle" && "bg-muted/60",
            )}
          />
          {status === "connected" ? state?.info?.version ?? "Connected" : status === "connecting" ? "Connecting…" : status === "error" ? "Connection failed" : cfg.database ? `Not connected · ${cfg.database}` : "Not connected"}
        </span>
        <span className="flex items-center gap-1 font-medium opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100" style={{ color }}>
          Open <ArrowRight size={13} />
        </span>
      </div>
    </button>
  );
}

function EmptyConnections() {
  return (
    <button
      onClick={() => useStore.getState().setUi({ connDialog: { open: true } })}
      className="home-card flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-line-strong bg-panel/50 py-12 text-muted hover:text-fg"
    >
      <Plus size={28} />
      <span className="text-[14px] font-medium">Add your first connection</span>
      <span className="text-[12px]">PostgreSQL or MySQL, directly or through an SSH tunnel</span>
    </button>
  );
}
