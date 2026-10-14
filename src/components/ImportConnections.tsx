// Bring connections over from DBeaver, pgAdmin, MySQL Workbench, Sequel Ace and .pgpass.
import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileSearch, KeyRound, Lock, Network } from "lucide-react";
import { api, errorText, type ExternalCandidate, type ExternalSource } from "../lib/api";
import { ENVIRONMENTS } from "../lib/connStyle";
import { useStore } from "../store";
import { Toggle } from "./importParts";
import { Button, cx, DbIcon, Modal, Spinner } from "./ui";

const keyOf = (c: { kind: string; host: string; port: number; user: string; database: string }) =>
  [c.kind, c.host.toLowerCase(), c.port, c.user, c.database].join("|");

export function ImportConnectionsHost() {
  const open = useStore((s) => s.connImport);
  return open ? <ImportConnections /> : null;
}

function ImportConnections() {
  const close = () => useStore.getState().setUi({ connImport: false });
  const existing = useStore((s) => s.connections);
  const [withPasswords, setWithPasswords] = useState(true);
  const [groupsAsProjects, setGroupsAsProjects] = useState(true);
  const [sources, setSources] = useState<ExternalSource[] | null>(null);
  const [extra, setExtra] = useState<ExternalSource[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const all = useMemo(() => [...(sources ?? []), ...extra], [sources, extra]);
  // the first time a connection shows up; later copies (other tools, already saved here) are duplicates
  const rows = useMemo(() => {
    const seen = new Set(existing.map((c) => keyOf(c)));
    return all.map((s, si) => ({
      source: s,
      items: s.connections.map((c, ci) => {
        const k = keyOf(c);
        const already = existing.some((e) => keyOf(e) === k);
        const dup = seen.has(k);
        seen.add(k);
        return { id: `${si}:${ci}`, c, already, dup };
      }),
    }));
  }, [all, existing]);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSources(await api.findExternalConnections(withPasswords));
    } catch (e) {
      setError(errorText(e));
      setSources([]);
    }
  }, [withPasswords]);

  useEffect(() => {
    void load();
  }, [load]);

  // new results: pick everything that isn't a duplicate
  useEffect(() => {
    setPicked(new Set(rows.flatMap((r) => r.items.filter((i) => !i.dup).map((i) => i.id))));
  }, [rows]);

  const pickFile = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Connections", extensions: ["json", "xml", "db", "plist", "conf", "pgpass", "txt"] }, { name: "All files", extensions: ["*"] }],
    });
    if (typeof path !== "string") return;
    try {
      const found = await api.readConnectionsFile(path, withPasswords);
      setExtra((x) => [...x, found]);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const chosen = rows.flatMap((r) => r.items.filter((i) => picked.has(i.id)).map((i) => i.c));

  const run = async () => {
    setBusy(true);
    setError(null);
    const st = useStore.getState();
    const projectIds = new Map<string, string>();
    try {
      if (groupsAsProjects) {
        for (const g of new Set(chosen.map((c) => c.group).filter((g): g is string => !!g))) {
          const known = st.projects.find((p) => p.name === g);
          const saved = known ?? (await api.saveProject({ id: "", name: g, color: null, icon: { type: "lucide", name: "Folder" } }));
          if (!known) st.upsertProject(saved);
          projectIds.set(g, saved.id);
        }
      }
      for (const c of chosen) {
        const env = ENVIRONMENTS.find((e) => e.key === c.environment);
        const saved = await api.saveConnection({
          id: "",
          name: c.name || `${c.user}@${c.host}`,
          kind: c.kind,
          host: c.host,
          port: c.port,
          user: c.user,
          database: c.database,
          ssl: c.ssl,
          ssh: c.ssh,
          environment: env?.key ?? null,
          color: env?.defaultColor ?? c.color ?? null,
          projectId: (groupsAsProjects && c.group && projectIds.get(c.group)) || null,
          savePassword: !!c.password,
          password: c.password,
          sshSecret: c.sshSecret,
        });
        st.upsertConnection(saved);
      }
      close();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const total = rows.reduce((a, r) => a + r.items.length, 0);

  return (
    <Modal title="Import connections" onClose={close} width={760}>
      <div className="flex max-h-[68vh] flex-col gap-4 overflow-y-auto px-5 py-4">
        <p className="text-[13px] text-fg-2">Connections saved by DBeaver, pgAdmin 4, MySQL Workbench, Sequel Ace and .pgpass on this computer. Nothing is changed in those tools.</p>

        {sources === null ? (
          <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
            <Spinner /> Looking for saved connections…
          </div>
        ) : total === 0 && rows.every((r) => !r.source.error) ? (
          <div className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-muted">
            No saved connections found. You can still pick an exported file below.
          </div>
        ) : (
          rows.map(({ source: s, items }) => (
            <section key={s.path} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <h3 className="text-[13px] font-semibold" title={s.path}>
                  {s.tool}
                </h3>
                <span className="text-[11.5px] text-muted">{items.length} connection{items.length === 1 ? "" : "s"}</span>
              </div>
              {s.error && <p className="text-[12px] text-err">{s.error}</p>}
              {s.note && <p className="text-[11.5px] text-muted">{s.note}</p>}
              <div className="overflow-hidden rounded-lg border border-line">
                {items.map(({ id, c, already, dup }) => (
                  <Row key={id} c={c} checked={picked.has(id)} onToggle={() => toggle(id)} label={already ? "Already added" : dup ? "Duplicate" : null} />
                ))}
              </div>
            </section>
          ))
        )}

        <button onClick={() => void pickFile()} className="flex items-center gap-2 self-start text-[12.5px] text-accent hover:underline">
          <FileSearch size={14} /> Import from a file… (data-sources.json, servers.json, connections.xml, Favorites.plist, pgpass)
        </button>

        <div className="flex flex-col gap-1 border-t border-line pt-3">
          <Toggle checked={withPasswords} onChange={setWithPasswords} label="Bring saved passwords" hint="From DBeaver and .pgpass, stored in the system keychain like the rest." />
          <Toggle checked={groupsAsProjects} onChange={setGroupsAsProjects} label="Folders and groups become projects" />
        </div>
        {error && <p className="selectable text-[12.5px] text-err">{error}</p>}
      </div>
      <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
        <span className="text-[12px] text-muted">{chosen.length} selected</span>
        <div className="ml-auto flex gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={busy || chosen.length === 0} onClick={() => void run()}>
            {busy && <Spinner />} Import {chosen.length || ""} connection{chosen.length === 1 ? "" : "s"}
          </Button>
        </div>
      </footer>
    </Modal>
  );
}

function Row({ c, checked, onToggle, label }: { c: ExternalCandidate; checked: boolean; onToggle: () => void; label: string | null }) {
  const env = ENVIRONMENTS.find((e) => e.key === c.environment);
  return (
    <button onClick={onToggle} className={cx("flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-hover", !checked && "opacity-60")}>
      <input type="checkbox" readOnly checked={checked} className="pointer-events-none accent-[var(--accent)]" />
      <DbIcon kind={c.kind} size={18} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-fg">{c.name || `${c.user}@${c.host}`}</span>
          {env && <span className="rounded px-1.5 text-[10px] font-bold tracking-wide text-muted ring-1 ring-line-strong">{env.short}</span>}
          {c.group && <span className="truncate text-[11px] text-muted">in {c.group}</span>}
        </span>
        <span className="block truncate font-mono text-[11.5px] text-muted">
          {c.user ? `${c.user}@` : ""}
          {c.host}:{c.port}
          {c.database ? `/${c.database}` : ""}
        </span>
      </span>
      {c.ssh && (
        <span className="flex items-center gap-1 text-[11px] text-muted" title={`SSH via ${c.ssh.host}`}>
          <Network size={13} /> SSH
        </span>
      )}
      {c.password ? (
        <span className="flex items-center gap-1 text-[11px] text-ok" title="The password comes along">
          <KeyRound size={13} />
        </span>
      ) : (
        <span className="flex items-center gap-1 text-[11px] text-muted" title="You'll enter the password on first connect">
          <Lock size={13} />
        </span>
      )}
      {label && <span className="text-[11px] text-warn">{label}</span>}
    </button>
  );
}
