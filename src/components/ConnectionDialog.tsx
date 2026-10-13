// Connection editor (with SSH tunnel) and the password prompt.
import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { CircleAlert, CircleCheck, FolderOpen, KeyRound, Plug, Trash2 } from "lucide-react";
import { api, defaultPort, errorText, kindLabel, type ConnectionConfig, type DbKind, type ServerInfo, type SshConfig, type SslMode } from "../lib/api";
import { CONN_COLORS, ENVIRONMENTS } from "../lib/connStyle";
import { useStore } from "../store";
import { Button, cx, DbIcon, IconButton, Modal, Spinner } from "./ui";
import { baseId } from "../lib/connIds";

export const field =
  "h-9 w-full rounded-md border border-line-strong bg-bg/40 px-3 text-[13px] text-fg outline-none focus:border-accent disabled:opacity-50";

const defaultSsh = (): SshConfig => ({ enabled: false, host: "", port: 22, user: "", auth: "password", keyPath: "" });

export function ConnectionDialog() {
  const dlg = useStore((s) => s.connDialog);
  if (!dlg.open) return null;
  return <ConnectionForm editing={dlg.editing} defaultProjectId={dlg.projectId ?? null} key={dlg.editing?.id ?? "new"} />;
}

function ConnectionForm({ editing, defaultProjectId }: { editing?: ConnectionConfig; defaultProjectId: string | null }) {
  const projects = useStore((s) => s.projects);
  const close = () => useStore.getState().setUi({ connDialog: { open: false } });
  const [form, setForm] = useState<ConnectionConfig>(
    editing ?? {
      id: "",
      name: "",
      kind: "postgres",
      host: "localhost",
      port: 5432,
      user: "",
      database: "",
      ssl: "prefer",
      savePassword: true,
      ssh: defaultSsh(),
      projectId: defaultProjectId,
    },
  );
  const ssh = form.ssh ?? defaultSsh();
  const [section, setSection] = useState<"general" | "ssh">("general");
  const [password, setPassword] = useState("");
  const [pwTouched, setPwTouched] = useState(false);
  const [sshSecret, setSshSecret] = useState("");
  const [sshTouched, setSshTouched] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<{ ok: true; info: ServerInfo } | { ok: false; error: string } | null>(null);

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setSsh = <K extends keyof SshConfig>(k: K, v: SshConfig[K]) => setForm((f) => ({ ...f, ssh: { ...(f.ssh ?? defaultSsh()), [k]: v } }));
  const setKind = (kind: DbKind) => setForm((f) => ({ ...f, kind, port: f.port === defaultPort(f.kind) ? defaultPort(kind) : f.port }));

  const input = () => ({
    ...form,
    ssh,
    name: form.name.trim() || `${kindLabel(form.kind)} ${ssh.enabled ? ssh.host : form.host}`,
    password: editing && !pwTouched ? null : password,
    sshSecret: editing && !sshTouched ? null : sshSecret,
  });

  const test = async () => {
    setBusy("test");
    setResult(null);
    try {
      setResult({ ok: true, info: await api.testConnection(input()) });
    } catch (e) {
      setResult({ ok: false, error: errorText(e) });
    }
    setBusy(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("save");
    try {
      const data = input();
      const saved = await api.saveConnection(data);
      const st = useStore.getState();
      st.upsertConnection(saved);
      st.selectConnection(saved.id);
      close();
      // connect right away, using the form's passwords if they weren't saved
      void st.connectTo(saved.id, saved.savePassword ? undefined : { password: data.password ?? "", sshSecret: data.sshSecret ?? undefined });
    } catch (err) {
      setResult({ ok: false, error: errorText(err) });
      setBusy(null);
    }
  };

  const pickKey = async () => {
    const path = await openFileDialog({ multiple: false, title: "Select private key" });
    if (typeof path === "string") setSsh("keyPath", path);
  };

  return (
    <Modal title={editing ? "Edit Connection" : "New Connection"} onClose={close} width={540}>
      <form onSubmit={submit}>
        <div className="flex gap-1 border-b border-line px-5 pt-2">
          {(["general", "ssh"] as const).map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => setSection(s)}
              className={cx(
                "relative flex items-center gap-2 px-3 py-2.5 text-[13px]",
                section === s ? "text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-accent" : "text-fg-2 hover:text-fg",
              )}
            >
              {s === "general" ? "General" : "SSH Tunnel"}
              {s === "ssh" && ssh.enabled && <span className="h-1.5 w-1.5 rounded-full bg-ok" />}
            </button>
          ))}
        </div>

        <div className="space-y-4 px-5 py-4">
          {section === "general" ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                {(["postgres", "mysql"] as DbKind[]).map((k) => (
                  <button
                    type="button"
                    key={k}
                    onClick={() => setKind(k)}
                    className={cx(
                      "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-[13px]",
                      form.kind === k ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-fg-2 hover:bg-hover",
                    )}
                  >
                    <DbIcon kind={k} size={20} /> {kindLabel(k)}
                  </button>
                ))}
              </div>

              <Field label="Name">
                <input className={field} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Acme Prod" autoFocus />
              </Field>
              <div className="grid grid-cols-[1fr_110px] gap-3">
                <Field label={ssh.enabled ? "Host (as seen from the SSH server)" : "Host"}>
                  <input className={field} value={form.host} onChange={(e) => set("host", e.target.value)} required />
                </Field>
                <Field label="Port">
                  <input className={field} type="number" min={1} max={65535} value={form.port} onChange={(e) => set("port", Number(e.target.value))} required />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="User">
                  <input className={field} value={form.user} onChange={(e) => set("user", e.target.value)} required />
                </Field>
                <Field label="Password">
                  <input
                    className={field}
                    type="password"
                    value={password}
                    placeholder={editing && !pwTouched && editing.savePassword ? "•••••• (saved)" : ""}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setPwTouched(true);
                    }}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Database">
                  <input
                    className={field}
                    value={form.database}
                    onChange={(e) => set("database", e.target.value)}
                    placeholder={form.kind === "postgres" ? "postgres" : "(optional)"}
                  />
                </Field>
                <Field label="SSL">
                  <select className={field} value={form.ssl} onChange={(e) => set("ssl", e.target.value as SslMode)}>
                    <option value="disable">Disable</option>
                    <option value="prefer">Prefer</option>
                    <option value="require">Require</option>
                  </select>
                </Field>
              </div>
              {projects.length > 0 && (
                <Field label="Project">
                  <select className={field} value={form.projectId ?? ""} onChange={(e) => set("projectId", e.target.value || null)}>
                    <option value="">No project</option>
                    {[...projects]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.icon?.type === "emoji" ? `${p.icon.value} ` : ""}
                          {p.name}
                        </option>
                      ))}
                  </select>
                </Field>
              )}
              <EnvironmentPicker
                environment={form.environment ?? null}
                color={form.color ?? null}
                onChange={(environment, color) => setForm((f) => ({ ...f, environment, color }))}
              />
            </>
          ) : (
            <>
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" className="accent-[var(--accent)]" checked={ssh.enabled} onChange={(e) => setSsh("enabled", e.target.checked)} />
                Connect through an SSH tunnel
              </label>
              <p className="text-[12px] leading-relaxed text-muted">
                The app logs in to the SSH server, then reaches the database host and port from the General tab <i>from that server</i>. Usually that
                host is <code className="mx-0.5 rounded bg-hover px-1">localhost</code>.
              </p>
              <fieldset disabled={!ssh.enabled} className="space-y-4">
                <div className="grid grid-cols-[1fr_110px] gap-3">
                  <Field label="SSH host">
                    <input className={field} value={ssh.host} onChange={(e) => setSsh("host", e.target.value)} placeholder="server.example.com" required={ssh.enabled} />
                  </Field>
                  <Field label="SSH port">
                    <input className={field} type="number" min={1} max={65535} value={ssh.port} onChange={(e) => setSsh("port", Number(e.target.value))} />
                  </Field>
                </div>
                <Field label="SSH user">
                  <input className={field} value={ssh.user} onChange={(e) => setSsh("user", e.target.value)} placeholder="ubuntu" required={ssh.enabled} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  {(["password", "key"] as const).map((a) => (
                    <button
                      type="button"
                      key={a}
                      onClick={() => setSsh("auth", a)}
                      className={cx(
                        "rounded-lg border px-3 py-2 text-[13px]",
                        ssh.auth === a ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-fg-2 hover:bg-hover",
                      )}
                    >
                      {a === "password" ? "Password" : "Private key"}
                    </button>
                  ))}
                </div>
                {ssh.auth === "key" && (
                  <Field label="Private key file">
                    <div className="flex gap-2">
                      <input
                        className={field}
                        value={ssh.keyPath}
                        onChange={(e) => setSsh("keyPath", e.target.value)}
                        placeholder="~/.ssh/id_ed25519"
                        required={ssh.enabled}
                      />
                      <Button type="button" className="h-9 shrink-0" onClick={() => void pickKey()}>
                        <FolderOpen size={15} /> Browse
                      </Button>
                    </div>
                  </Field>
                )}
                <Field label={ssh.auth === "password" ? "SSH password" : "Key passphrase (if the key has one)"}>
                  <input
                    className={field}
                    type="password"
                    value={sshSecret}
                    placeholder={editing && !sshTouched && editing.savePassword && editing.ssh?.enabled ? "•••••• (saved)" : ""}
                    onChange={(e) => {
                      setSshSecret(e.target.value);
                      setSshTouched(true);
                    }}
                  />
                </Field>
              </fieldset>
              <KnownHostInfo host={ssh.enabled && ssh.host ? `${ssh.host}:${ssh.port}` : null} />
            </>
          )}

          <label className="flex items-center gap-2 text-[13px] text-fg-2">
            <input type="checkbox" checked={form.savePassword} onChange={(e) => set("savePassword", e.target.checked)} className="accent-[var(--accent)]" />
            Save passwords in the system keychain
          </label>

          {result && (
            <div className={cx("selectable flex items-start gap-2 rounded-md px-3 py-2.5 text-[13px]", result.ok ? "bg-ok/10 text-ok" : "bg-err/10 text-err")}>
              {result.ok ? <CircleCheck size={16} className="mt-0.5 shrink-0" /> : <CircleAlert size={16} className="mt-0.5 shrink-0" />}
              <span className="break-words">
                {result.ok
                  ? `Connected to ${result.info.version} as ${result.info.user}${result.info.ssl ? " (SSL)" : ""}${ssh.enabled ? ` via SSH ${ssh.host}` : ""}`
                  : result.error}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 border-t border-line pt-4">
            <Button type="button" onClick={() => void test()} disabled={!!busy}>
              {busy === "test" ? <Spinner /> : <Plug size={15} />} Test
            </Button>
            <div className="flex-1" />
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!!busy}>
              {busy === "save" && <Spinner />} Save
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** Environment (dev/staging/production) and color. */
function EnvironmentPicker({
  environment,
  color,
  onChange,
}: {
  environment: ConnectionConfig["environment"];
  color: string | null;
  onChange: (environment: ConnectionConfig["environment"], color: string | null) => void;
}) {
  const envColor = (key: string | null) => ENVIRONMENTS.find((e) => e.key === key)?.defaultColor ?? null;
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <Field label="Environment">
        <div className="grid grid-cols-4 gap-1.5">
          {[{ key: null, label: "None" }, ...ENVIRONMENTS].map((e) => (
            <button
              type="button"
              key={e.key ?? "none"}
              onClick={() => {
                // color follows the environment until changed by hand
                const autoColor = !color || color === envColor(environment ?? null);
                onChange(e.key, autoColor ? envColor(e.key) : color);
              }}
              className={cx(
                "rounded-md border px-2 py-1.5 text-[12.5px]",
                environment === e.key || (!environment && e.key === null)
                  ? e.key === "production"
                    ? "border-err bg-err/15 text-err"
                    : "border-accent bg-accent-soft text-fg"
                  : "border-line-strong text-fg-2 hover:bg-hover",
              )}
            >
              {e.label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Color">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            title="No color"
            onClick={() => onChange(environment, null)}
            className={cx("h-6 w-6 rounded-full border border-line-strong text-[11px] text-muted", !color && "ring-2 ring-accent ring-offset-2 ring-offset-panel")}
          >
            ∅
          </button>
          {CONN_COLORS.map((c) => (
            <button
              type="button"
              key={c.key}
              title={c.label}
              onClick={() => onChange(environment, c.key)}
              style={{ background: c.hex }}
              className={cx("h-6 w-6 rounded-full", color === c.key && "ring-2 ring-fg ring-offset-2 ring-offset-panel")}
            />
          ))}
        </div>
      </Field>
      {environment === "production" && (
        <p className="text-[12px] text-err">Statements that change data or structure will ask for confirmation before running.</p>
      )}
    </div>
  );
}

/** Remembered SSH host key fingerprint, with a way to forget it. */
function KnownHostInfo({ host }: { host: string | null }) {
  const [known, setKnown] = useState<[string, string][]>([]);
  const reload = () => {
    api.listKnownHosts().then(setKnown, () => setKnown([]));
  };
  useEffect(reload, []);
  if (!host) return null;
  const entry = known.find(([h]) => h === host);
  return (
    <div className="flex items-center gap-2 rounded-md bg-hover/50 px-3 py-2 text-[12px] text-muted">
      <KeyRound size={14} className="shrink-0" />
      {entry ? (
        <>
          <span className="selectable flex-1 truncate" title={entry[1]}>
            Trusted host key: <span className="font-mono">{entry[1]}</span>
          </span>
          <IconButton title="Forget this host key (if the server was reinstalled)" onClick={() => void api.forgetKnownHost(host).then(reload)}>
            <Trash2 size={13} />
          </IconButton>
        </>
      ) : (
        <span>The host key of the server is remembered on the first connect and checked on every connect after that.</span>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] text-muted">{label}</span>
      {children}
    </label>
  );
}


export function PasswordDialog() {
  const prompt = useStore((s) => s.passwordPrompt);
  const cfg = useStore((s) => s.connections.find((c) => c.id === baseId(prompt?.connId)));
  const [pw, setPw] = useState("");
  const [sshPw, setSshPw] = useState("");
  useEffect(() => {
    setPw("");
    setSshPw("");
  }, [prompt]);
  if (!prompt || !cfg) return null;
  const submit = useStore.getState().submitPassword;
  const ssh = cfg.ssh?.enabled ? cfg.ssh : null;
  return (
    <Modal title={`Password for ${cfg.name}`} onClose={() => submit(null)} width={420}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit({ password: pw, sshSecret: ssh ? sshPw : undefined });
        }}
        className="space-y-4 px-5 py-4"
      >
        {prompt.error && <p className="selectable text-[13px] text-err">{prompt.error}</p>}
        {ssh && (
          <Field label={`${ssh.auth === "password" ? "SSH password" : "Key passphrase (optional)"} for ${ssh.user}@${ssh.host}`}>
            <input className={field} type="password" autoFocus value={sshPw} onChange={(e) => setSshPw(e.target.value)} />
          </Field>
        )}
        <Field label={`Database password for ${cfg.user}@${cfg.host}:${cfg.port}`}>
          <input className={field} type="password" autoFocus={!ssh} value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => submit(null)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Connect
          </Button>
        </div>
      </form>
    </Modal>
  );
}
