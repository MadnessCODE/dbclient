// Users & privileges: accounts on the left, account and privileges on the right; edits are previewed as SQL.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Check, Copy, Dices, Eye, EyeOff, Sheet, KeyRound, Lock, Minus, Plus, RotateCcw, Search, ShieldCheck, Trash2, TriangleAlert, UserRound, Users } from "lucide-react";
import { errorText, type DbKind, type SchemaInfo } from "../lib/api";
import { isProduction } from "../lib/connStyle";
import {
  accountKey,
  applyStatements,
  buildSql,
  currentObjectPrivs,
  dropSql,
  emptyPrivileges,
  GRANT_OPTION,
  listAccounts,
  loadMyPrivileges,
  loadPgPrivileges,
  loadPgTotals,
  loadViewWritability,
  MY_DB_GROUPS,
  MY_GLOBAL_GROUP,
  OBJECT_PRIVS,
  objKey,
  myPreset,
  objectState,
  PG_DB_PRIVS,
  PG_SCHEMA_PRIVS,
  PG_SEQ_PRIVS,
  PG_TABLE_PRIVS,
  pgPreset,
  PRESETS,
  type Account,
  type Draft,
  type MyAccount,
  type PgRole,
  type PrivDef,
  type Stmt,
} from "../lib/users";
import { useStore } from "../store";
import { Button, cx, EnvBadge, Modal, Spinner } from "./ui";
import { baseId } from "../lib/connIds";

const input = "h-8 w-full rounded-md border border-line-strong bg-bg/50 px-2.5 text-[13px] text-fg outline-none focus:border-accent";
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** Updatable views (objKey -> true); materialized views never are. */
const ViewWritability = createContext<Record<string, boolean>>({});

export function UsersDialogHost() {
  const dlg = useStore((s) => s.usersDialog);
  if (!dlg) return null;
  return (
    <UsersDialog
      key={`${dlg.connId}|${dlg.user ?? ""}|${dlg.drop ? 1 : 0}`}
      connId={dlg.connId}
      initialUser={dlg.user}
      initialDrop={dlg.drop}
      onClose={() => useStore.getState().setUi({ usersDialog: null })}
    />
  );
}

function newDraft(kind: DbKind): Draft {
  const account: Account =
    kind === "mysql"
      ? { kind, user: "", host: "%", plugin: "", locked: false, isNew: true }
      : {
          kind,
          name: "",
          login: true,
          superuser: false,
          createdb: false,
          createrole: false,
          replication: false,
          bypassrls: false,
          inherit: true,
          connLimit: -1,
          validUntil: null,
          memberOf: [],
          isNew: true,
        };
  return {
    account,
    password: "",
    privileges: emptyPrivileges(),
    objectTargets: {},
  };
}

function UsersDialog({ connId, initialUser, initialDrop, onClose }: { connId: string; initialUser?: string; initialDrop?: boolean; onClose: () => void }) {
  const cfg = useStore((s) => s.connections.find((c) => c.id === baseId(connId)));
  const conn = useStore((s) => s.conn[connId]);
  const kind: DbKind = cfg?.kind ?? "postgres";
  const mysql = kind === "mysql";
  const dbName = conn?.info?.database || cfg?.database || "";
  const schemaInfos = useMemo(() => (conn?.schema?.schemas ?? []).filter((s) => !s.system), [conn?.schema]);
  const scopes = useMemo(() => schemaInfos.map((s) => s.name), [schemaInfos]);

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [original, setOriginal] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [tab, setTab] = useState<"account" | "privileges" | "grants">("account");
  const [review, setReview] = useState<Stmt[] | null>(null);
  const [writable, setWritable] = useState<Record<string, boolean>>({});
  useEffect(() => {
    loadViewWritability(connId, kind).then(setWritable, () => setWritable({}));
  }, [connId, kind]);
  const [dropping, setDropping] = useState(false);

  const reload = async (keep?: string) => {
    setListError(null);
    try {
      const list = await listAccounts(connId, kind);
      setAccounts(list);
      if (keep) await select(keep, list);
    } catch (e) {
      setListError(errorText(e));
    }
  };
  /** Tells the tree to reload its user list */
  const changed = () => useStore.getState().setUi({ usersVersion: useStore.getState().usersVersion + 1 });
  useEffect(() => {
    void (async () => {
      await reload(initialUser && initialUser !== "new" ? initialUser : undefined);
      if (initialUser === "new") await select("new");
      if (initialDrop && initialUser) setDropping(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  const statements = useMemo(() => (draft ? buildSql(kind, original, draft) : []), [kind, original, draft]);
  const dirty = statements.length > 0 && (selected !== "new" || accountKey(draft!.account).replace(/@.*$/, "") !== "");

  const select = async (key: string | "new", list = accounts) => {
    setDetailError(null);
    setSelected(key);
    if (key === "new") {
      setOriginal(null);
      const d = newDraft(kind);
      setDraft(d);
      setTab("account");
      if (kind === "postgres") {
        const objects = await loadPgTotals(connId).catch(() => ({}));
        setDraft((cur) => cur && { ...cur, privileges: { ...cur.privileges, objects } });
      }
      return;
    }
    const a = list?.find((x) => accountKey(x) === key);
    if (!a) return;
    setLoading(true);
    setDraft(null);
    try {
      const privileges = a.kind === "mysql" ? await loadMyPrivileges(connId, a) : await loadPgPrivileges(connId, a.name);
      const d: Draft = {
        account: a,
        password: "",
        privileges,
        objectTargets: {},
      };
      setOriginal(d);
      setDraft(clone(d));
    } catch (e) {
      setDetailError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  const trySelect = (key: string | "new") => {
    if (dirty && !window.confirm("Discard the unsaved changes for this user?")) return;
    void select(key);
  };

  const visible = (accounts ?? []).filter((a) => accountKey(a).toLowerCase().includes(filter.toLowerCase()));
  const nameOk = draft ? (draft.account.kind === "mysql" ? draft.account.user.trim() !== "" && draft.account.host.trim() !== "" : draft.account.name.trim() !== "") : false;

  return (
    <Modal title="Users & privileges" onClose={onClose} width={1120}>
      <ViewWritability.Provider value={writable}>
        <div className="flex items-center gap-2 border-b border-line px-5 py-2 text-[12.5px] text-fg-2">
          <Users size={14} className="text-accent" />
          <span className="font-medium text-fg">{cfg?.name}</span>
          <EnvBadge cfg={cfg} />
          {!mysql && dbName && <span className="text-muted">· privileges shown for database {dbName}</span>}
        </div>
        <div className="flex h-[600px]">
          {/* accounts */}
          <aside className="flex w-[270px] shrink-0 flex-col border-r border-line">
            <div className="flex gap-1.5 p-3">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-2.5 top-2 text-muted" />
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter users…" className={cx(input, "pl-8")} />
              </div>
              <Button variant="primary" className="h-8 !px-2.5" title="New user" onClick={() => trySelect("new")}>
                <Plus size={15} />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {listError ? (
                <p className="px-2 text-[12.5px] leading-relaxed text-err">
                  {listError}
                  <br />
                  <span className="text-fg-2">Listing users needs extra rights ({mysql ? "SELECT on mysql.user" : "access to pg_roles"}).</span>
                </p>
              ) : !accounts ? (
                <div className="flex justify-center py-6">
                  <Spinner />
                </div>
              ) : (
                <>
                  {selected === "new" && (
                    <div className="mb-1 flex items-center gap-2 rounded-lg bg-accent-soft px-2.5 py-2 text-[13px] text-fg">
                      <Plus size={15} className="text-accent" /> New user
                    </div>
                  )}
                  {visible.map((a) => {
                    const key = accountKey(a);
                    return (
                      <button
                        key={key}
                        onClick={() => key !== selected && trySelect(key)}
                        className={cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left", key === selected ? "bg-accent-soft" : "hover:bg-hover")}
                      >
                        {a.kind === "postgres" && !a.login ? <Users size={15} className="shrink-0 text-violet-300" /> : <UserRound size={15} className="shrink-0 text-muted" />}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-fg">{a.kind === "mysql" ? a.user || "(anonymous)" : a.name}</span>
                          <span className="block truncate text-[11px] text-muted">{a.kind === "mysql" ? `@ ${a.host}` : a.login ? "user" : "role (no login)"}</span>
                        </span>
                        {a.kind === "mysql" && a.locked && <Lock size={13} className="shrink-0 text-warn" />}
                        {a.kind === "postgres" && a.superuser && <span className="rounded bg-err/15 px-1 text-[9.5px] font-bold text-err">SUPER</span>}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </aside>

          {/* details */}
          <section className="flex min-w-0 flex-1 flex-col">
            {!selected ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted">
                <ShieldCheck size={36} className="text-accent/60" />
                <div className="text-[14px] text-fg-2">Pick a user to see and change what it can do</div>
                <div className="text-[12.5px]">or create a new one with +</div>
              </div>
            ) : loading || !draft ? (
              <div className="flex flex-1 items-center justify-center">{detailError ? <p className="px-6 text-[13px] text-err">{detailError}</p> : <Spinner />}</div>
            ) : (
              <>
                <div className="flex items-end gap-1 border-b border-line px-4">
                  {([["account", "Account"], ["privileges", "Privileges"], ...(mysql && original ? [["grants", "Current grants"]] : [])] as [typeof tab, string][]).map(
                    ([k, label]) => (
                      <button
                        key={k}
                        onClick={() => setTab(k)}
                        className={cx(
                          "relative px-4 py-2.5 text-[13px]",
                          tab === k ? "text-fg after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:bg-accent" : "text-fg-2 hover:text-fg",
                        )}
                      >
                        {label}
                      </button>
                    ),
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-5">
                  {tab === "account" &&
                    (draft.account.kind === "mysql" ? (
                      <MyAccountForm draft={draft} setDraft={setDraft} isNew={!original} />
                    ) : (
                      <PgAccountForm draft={draft} setDraft={setDraft} isNew={!original} roles={(accounts ?? []).filter((a): a is Account & PgRole => a.kind === "postgres")} />
                    ))}
                  {tab === "privileges" &&
                    (mysql ? (
                      <MyPrivileges draft={draft} setDraft={setDraft} databases={scopes} infos={schemaInfos} />
                    ) : (
                      <PgPrivileges draft={draft} setDraft={setDraft} original={original} schemas={scopes} infos={schemaInfos} dbName={dbName} />
                    ))}
                  {tab === "grants" && (
                    <pre className="selectable overflow-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-[12px] leading-relaxed text-fg-2">
                      {draft.privileges.raw.join(";\n") + ";"}
                    </pre>
                  )}
                </div>
                <footer className="flex items-center gap-2 border-t border-line px-4 py-3">
                  {original && (
                    <Button variant="ghost" className="text-err hover:bg-err/10 hover:text-err" onClick={() => setDropping(true)}>
                      <Trash2 size={14} /> Delete user
                    </Button>
                  )}
                  <span className="ml-auto text-[12.5px] text-muted">{dirty ? `${statements.length} change${statements.length === 1 ? "" : "s"}` : "No changes"}</span>
                  <Button disabled={!dirty} onClick={() => setDraft(original ? clone(original) : newDraft(kind))}>
                    <RotateCcw size={14} /> Revert
                  </Button>
                  <Button variant="primary" disabled={!dirty || !nameOk} onClick={() => setReview(statements)}>
                    <Check size={15} /> {original ? "Review & apply" : "Review & create"}
                  </Button>
                </footer>
              </>
            )}
          </section>
        </div>

        {review && draft && (
          <ApplyDialog
            title={original ? "Apply changes" : "Create user"}
            kind={kind}
            production={isProduction(cfg)}
            statements={review}
            onClose={() => setReview(null)}
            onApply={async () => {
              await applyStatements(connId, kind, review, dbName);
              setReview(null);
              changed();
              await reload(accountKey(draft.account));
            }}
          />
        )}
        {dropping && draft && original && (
          <DropDialog
            account={original.account}
            kind={kind}
            production={isProduction(cfg)}
            currentUser={conn?.info?.user ?? ""}
            onClose={() => setDropping(false)}
            onDrop={async (reassign) => {
              await applyStatements(connId, kind, dropSql(kind, original.account, reassign), dbName);
              setDropping(false);
              setSelected(null);
              setDraft(null);
              setOriginal(null);
              changed();
              await reload();
            }}
          />
        )}
      </ViewWritability.Provider>
    </Modal>
  );
}


type SetDraft = React.Dispatch<React.SetStateAction<Draft | null>>;

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] text-fg-2">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] leading-snug text-muted">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint, danger }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; danger?: boolean }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-start gap-2.5 text-left">
      <span
        className={cx(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
          checked ? (danger ? "border-err bg-err text-white" : "border-accent bg-accent text-white") : "border-line-strong",
        )}
      >
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      <span>
        <span className={cx("block text-[13px]", danger && checked ? "text-err" : "text-fg")}>{label}</span>
        {hint && <span className="block text-[11.5px] leading-snug text-muted">{hint}</span>}
      </span>
    </button>
  );
}

function PasswordField({ value, onChange, isNew }: { value: string; onChange: (v: string) => void; isNew: boolean }) {
  const [show, setShow] = useState(false);
  const generate = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*_-";
    const bytes = crypto.getRandomValues(new Uint32Array(20));
    onChange(Array.from(bytes, (b) => chars[b % chars.length]).join(""));
    setShow(true);
  };
  return (
    <Field label={isNew ? "Password" : "New password"} hint={isNew ? undefined : "Leave empty to keep the current password."}>
      <div className="flex gap-1.5">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={isNew ? "" : "unchanged"}
          className={cx(input, "font-mono")}
          autoComplete="new-password"
        />
        <Button className="h-8 w-8 shrink-0 !px-0" title={show ? "Hide" : "Show"} onClick={() => setShow(!show)}>
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </Button>
        <Button className="h-8 w-8 shrink-0 !px-0" title="Generate a strong password" onClick={generate}>
          <Dices size={14} />
        </Button>
        <Button className="h-8 w-8 shrink-0 !px-0" title="Copy" disabled={!value} onClick={() => void navigator.clipboard.writeText(value)}>
          <Copy size={14} />
        </Button>
      </div>
    </Field>
  );
}

const HOSTS: [string, string][] = [
  ["%", "Any host"],
  ["localhost", "Only on the server itself"],
  ["127.0.0.1", "Local TCP"],
  ["10.%", "Private network 10.x"],
  ["192.168.%", "Private network 192.168.x"],
];

function MyAccountForm({ draft, setDraft, isNew }: { draft: Draft; setDraft: SetDraft; isNew: boolean }) {
  const a = draft.account as MyAccount & { kind: "mysql" };
  const set = (p: Partial<MyAccount>) => setDraft((d) => d && { ...d, account: { ...a, ...p } });
  return (
    <div className="grid max-w-[640px] grid-cols-2 gap-x-5 gap-y-4">
      <Field label="User name">
        <input autoFocus={isNew} value={a.user} onChange={(e) => set({ user: e.target.value })} className={cx(input, "font-mono")} placeholder="app_user" />
      </Field>
      <Field label="Can connect from (host)" hint={HOSTS.find(([h]) => h === a.host)?.[1] ?? "Host name, IP or pattern with %"}>
        <input list="mysql-hosts" value={a.host} onChange={(e) => set({ host: e.target.value })} className={cx(input, "font-mono")} />
        <datalist id="mysql-hosts">
          {HOSTS.map(([h, l]) => (
            <option key={h} value={h}>
              {l}
            </option>
          ))}
        </datalist>
      </Field>
      <div className="col-span-2">
        <PasswordField value={draft.password} onChange={(password) => setDraft((d) => d && { ...d, password })} isNew={isNew} />
      </div>
      <div className="col-span-2">
        <Toggle checked={a.locked} onChange={(locked) => set({ locked })} label="Account locked" hint="A locked account can't log in, but keeps its privileges." />
      </div>
      {a.plugin && <p className="col-span-2 text-[12px] text-muted">Authentication: {a.plugin}</p>}
    </div>
  );
}

function PgAccountForm({ draft, setDraft, isNew, roles }: { draft: Draft; setDraft: SetDraft; isNew: boolean; roles: PgRole[] }) {
  const r = draft.account as PgRole & { kind: "postgres" };
  const set = (p: Partial<PgRole>) => setDraft((d) => d && { ...d, account: { ...r, ...p } });
  const others = roles.filter((x) => x.name !== r.name);
  return (
    <div className="grid max-w-[720px] grid-cols-2 gap-x-6 gap-y-4">
      <Field label="Role name">
        <input autoFocus={isNew} value={r.name} onChange={(e) => set({ name: e.target.value })} className={cx(input, "font-mono")} placeholder="app_user" />
      </Field>
      <div className="flex items-end pb-1.5">
        <Toggle checked={r.login} onChange={(login) => set({ login })} label="Can log in" hint="Off = a group role that others can be members of." />
      </div>
      {r.login && (
        <div className="col-span-2">
          <PasswordField value={draft.password} onChange={(password) => setDraft((d) => d && { ...d, password })} isNew={isNew} />
        </div>
      )}
      <Field label="Connection limit" hint="Empty = unlimited">
        <input
          type="number"
          min={-1}
          value={r.connLimit < 0 ? "" : r.connLimit}
          onChange={(e) =>
            set({
              connLimit: e.target.value === "" ? -1 : Math.max(-1, Number(e.target.value)),
            })
          }
          className={input}
          placeholder="unlimited"
        />
      </Field>
      <Field label="Valid until" hint="Empty = never expires">
        <input type="date" value={r.validUntil?.slice(0, 10) ?? ""} onChange={(e) => set({ validUntil: e.target.value || null })} className={input} />
      </Field>
      <div className="col-span-2 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-line p-4">
        <Toggle checked={r.superuser} onChange={(superuser) => set({ superuser })} danger label="Superuser" hint="Bypasses every permission check. Use sparingly." />
        <Toggle checked={r.createdb} onChange={(createdb) => set({ createdb })} label="Create databases" />
        <Toggle checked={r.createrole} onChange={(createrole) => set({ createrole })} label="Create roles" hint="Can create and change other roles." />
        <Toggle checked={r.inherit} onChange={(inherit) => set({ inherit })} label="Inherit privileges" hint="Gets privileges of the roles it is a member of." />
        <Toggle checked={r.replication} onChange={(replication) => set({ replication })} label="Replication" />
        <Toggle checked={r.bypassrls} onChange={(bypassrls) => set({ bypassrls })} label="Bypass row-level security" />
      </div>
      <div className="col-span-2 flex flex-col gap-2">
        <span className="text-[12.5px] text-fg-2">Member of</span>
        {others.length === 0 ? (
          <span className="text-[12px] text-muted">No other roles yet.</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {others.map((g) => {
              const on = r.memberOf.includes(g.name);
              return (
                <button
                  key={g.name}
                  onClick={() =>
                    set({
                      memberOf: on ? r.memberOf.filter((x) => x !== g.name) : [...r.memberOf, g.name],
                    })
                  }
                  className={cx(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
                    on ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-fg-2 hover:bg-hover hover:text-fg",
                  )}
                >
                  {on ? <Check size={12} /> : g.login ? <UserRound size={12} /> : <Users size={12} />}
                  {g.name}
                </button>
              );
            })}
          </div>
        )}
        <span className="text-[11.5px] text-muted">A member gets the privileges of these roles (when “Inherit privileges” is on).</span>
      </div>
    </div>
  );
}


function ScopeList({ items, value, onChange }: { items: { key: string; label: string; sub?: string; count: number }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="flex w-[210px] shrink-0 flex-col gap-0.5">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={cx("flex items-center gap-2 rounded-lg px-2.5 py-2 text-left", value === it.key ? "bg-accent-soft" : "hover:bg-hover")}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-fg">{it.label}</span>
            {it.sub && <span className="block truncate text-[11px] text-muted">{it.sub}</span>}
          </span>
          {it.count > 0 && <span className="rounded-full bg-accent/20 px-1.5 text-[10.5px] font-semibold tabular-nums text-accent">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Switch between scope-wide grants and single tables/views. */
function PartSwitch({ value, onChange, wide, objects }: { value: "all" | "objects"; onChange: (v: "all" | "objects") => void; wide: string; objects: number }) {
  return (
    <div className="flex w-fit rounded-lg border border-line-strong bg-panel-2 p-0.5">
      {(
        [
          ["all", wide],
          ["objects", `Tables & views${objects ? ` · ${objects}` : ""}`],
        ] as const
      ).map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} className={cx("h-7 rounded-md px-3 text-[12.5px]", value === k ? "bg-accent text-white" : "text-fg-2 hover:text-fg")}>
          {label}
        </button>
      ))}
    </div>
  );
}

function PresetBar({ onPick }: { onPick: (p: (typeof PRESETS)[number]["key"]) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[12px] text-muted">Quick set:</span>
      {PRESETS.map((p) => (
        <button
          key={p.key}
          title={p.hint}
          onClick={() => onPick(p.key)}
          className="h-7 rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12px] text-fg-2 hover:bg-hover hover:text-fg"
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function PrivCheck({ def, state, onToggle, extra }: { def: PrivDef; state: boolean | "some"; onToggle: () => void; extra?: string }) {
  return (
    <button onClick={onToggle} title={def.hint} className="flex items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover">
      <span
        className={cx(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
          state === true ? "border-accent bg-accent text-white" : state === "some" ? "border-accent bg-accent/30 text-white" : "border-line-strong",
        )}
      >
        {state === true ? <Check size={11} strokeWidth={3} /> : state === "some" ? <Minus size={11} strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0">
        <span className="block font-mono text-[12px] text-fg">{def.label}</span>
        <span className="block truncate text-[11px] text-muted">{extra ?? def.hint}</span>
      </span>
    </button>
  );
}

function MyPrivileges({ draft, setDraft, databases, infos }: { draft: Draft; setDraft: SetDraft; databases: string[]; infos: SchemaInfo[] }) {
  const [scope, setScope] = useState("*");
  const [part, setPart] = useState<"all" | "objects">("all");
  const granted = draft.privileges.granted;
  const objCount = (db: string) => Object.keys(draft.privileges.objectGrants).filter((k) => k.startsWith(`${db}\u0001`) && draft.privileges.objectGrants[k].length).length;
  const known = [...new Set([...databases, ...Object.keys(granted).filter((k) => k !== "*")])].sort();
  const cur = new Set(granted[scope] ?? []);
  const setScopePrivs = (list: string[]) =>
    setDraft(
      (d) =>
        d && {
          ...d,
          privileges: {
            ...d.privileges,
            granted: { ...d.privileges.granted, [scope]: list },
          },
        },
    );
  const toggle = (k: string) => setScopePrivs(cur.has(k) ? [...cur].filter((x) => x !== k) : [...cur, k]);
  const groups = scope === "*" ? [...MY_DB_GROUPS, MY_GLOBAL_GROUP] : MY_DB_GROUPS;

  return (
    <div className="flex gap-5">
      <ScopeList
        value={scope}
        onChange={setScope}
        items={[
          {
            key: "*",
            label: "All databases",
            sub: "global, incl. future ones",
            count: (granted["*"] ?? []).length,
          },
          ...known.map((db) => ({
            key: db,
            label: db,
            count: (granted[db] ?? []).length + objCount(db),
          })),
        ]}
      />
      <div className="min-w-0 flex-1 space-y-4">
        {scope !== "*" && <PartSwitch value={part} onChange={setPart} wide="Whole database" objects={objCount(scope)} />}
        {scope !== "*" && part === "objects" ? (
          <ObjectsMatrix
            scope={scope}
            info={infos.find((i) => i.name === scope)}
            draft={draft}
            setDraft={setDraft}
            inherited={(_, priv) => (cur.has(priv) ? "for the whole database" : (granted["*"] ?? []).includes(priv) ? "for all databases" : null)}
          />
        ) : (
          <>
            <PresetBar onPick={(p) => setScopePrivs([...myPreset(p), ...(cur.has("GRANT OPTION") && p !== "none" ? ["GRANT OPTION"] : [])])} />
            {scope === "*" && (
              <p className="flex items-start gap-1.5 rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-fg-2">
                <TriangleAlert size={14} className="mt-px shrink-0 text-warn" /> Global privileges apply to every database on the server. Prefer giving them per database.
              </p>
            )}
            {groups.map((g) => (
              <div key={g.title}>
                <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.title}</h4>
                <div className="grid grid-cols-3 gap-x-2">
                  {g.privs.map((p) => (
                    <PrivCheck key={p.key} def={p} state={cur.has(p.key)} onToggle={() => toggle(p.key)} />
                  ))}
                </div>
              </div>
            ))}
            <div className="border-t border-line pt-3">
              <PrivCheck def={GRANT_OPTION} state={cur.has("GRANT OPTION")} onToggle={() => toggle("GRANT OPTION")} />
            </div>
          </>
        )}
        {draft.privileges.other.length > 0 && (
          <div>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Other grants (kept as they are)</h4>
            <pre className="selectable overflow-auto rounded-lg border border-line bg-bg/60 p-2.5 font-mono text-[11.5px] text-fg-2">{draft.privileges.other.join("\n")}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function PgPrivileges({
  draft,
  setDraft,
  original,
  schemas,
  infos,
  dbName,
}: {
  draft: Draft;
  setDraft: SetDraft;
  original: Draft | null;
  schemas: string[];
  infos: SchemaInfo[];
  dbName: string;
}) {
  const [scope, setScope] = useState("db");
  const [part, setPart] = useState<"all" | "objects">("all");
  const p = draft.privileges;
  const objCount = (s: string) => Object.keys(p.objectGrants).filter((k) => k.startsWith(`${s}\u0001`) && p.objectGrants[k].length).length;
  // new role: totals come from the draft
  const base = original?.privileges ?? draft.privileges;
  const schema = scope.startsWith("schema:") ? scope.slice(7) : null;
  const owned = schema ? p.ownedSchemas.includes(schema) : false;
  const superuser = draft.account.kind === "postgres" && draft.account.superuser;

  const setGranted = (key: string, list: string[]) =>
    setDraft(
      (d) =>
        d && {
          ...d,
          privileges: {
            ...d.privileges,
            granted: { ...d.privileges.granted, [key]: list },
          },
        },
    );
  const target = (kind: "tables" | "sequences") => draft.objectTargets[`${kind}:${schema}`] ?? currentObjectPrivs(base.objects[`${kind}:${schema}`], kind);
  const setTarget = (kind: "tables" | "sequences", list: string[]) =>
    setDraft(
      (d) =>
        d && {
          ...d,
          objectTargets: { ...d.objectTargets, [`${kind}:${schema}`]: list },
        },
    );
  const objState = (kind: "tables" | "sequences", priv: string): boolean | "some" => {
    const key = `${kind}:${schema}`;
    if (draft.objectTargets[key]) return draft.objectTargets[key].includes(priv);
    const st = objectState(base.objects[key], priv);
    return st === "all" ? true : st === "some" ? "some" : false;
  };
  const count = (s: string) =>
    (p.granted[`schema:${s}`] ?? []).length + (draft.objectTargets[`tables:${s}`] ?? currentObjectPrivs(base.objects[`tables:${s}`], "tables")).length + objCount(s);

  return (
    <div className="flex gap-5">
      <ScopeList
        value={scope}
        onChange={setScope}
        items={[
          {
            key: "db",
            label: `Database ${dbName}`,
            sub: "connect, create schemas",
            count: (p.granted.db ?? []).length,
          },
          ...schemas.map((s) => ({
            key: `schema:${s}`,
            label: s,
            sub: p.ownedSchemas.includes(s) ? "owner" : "schema",
            count: count(s),
          })),
        ]}
      />
      <div className="min-w-0 flex-1 space-y-4">
        {superuser && (
          <p className="flex items-start gap-1.5 rounded-lg bg-err/10 px-3 py-2 text-[12px] text-fg-2">
            <TriangleAlert size={14} className="mt-px shrink-0 text-err" /> This role is a superuser: it can do everything regardless of these settings.
          </p>
        )}
        {scope === "db" ? (
          <div className="grid grid-cols-3 gap-x-2">
            {PG_DB_PRIVS.map((d) => {
              const cur = p.granted.db ?? [];
              return (
                <PrivCheck
                  key={d.key}
                  def={d}
                  state={cur.includes(d.key)}
                  onToggle={() => setGranted("db", cur.includes(d.key) ? cur.filter((x) => x !== d.key) : [...cur, d.key])}
                />
              );
            })}
            <p className="col-span-3 mt-2 text-[11.5px] leading-snug text-muted">
              By default every role can connect and use temporary tables through PUBLIC; these checkboxes are the role&apos;s own grants.
            </p>
          </div>
        ) : (
          schema && (
            <>
              <PartSwitch value={part} onChange={setPart} wide="Schema & all tables" objects={objCount(schema)} />
              {owned && (
                <p className="flex items-start gap-1.5 rounded-lg bg-accent-soft px-3 py-2 text-[12px] text-fg-2">
                  <KeyRound size={14} className="mt-px shrink-0 text-accent" /> This role owns the schema, so it already has every privilege on it.
                </p>
              )}
              {part === "objects" ? (
                <ObjectsMatrix
                  scope={schema}
                  info={infos.find((i) => i.name === schema)}
                  draft={draft}
                  setDraft={setDraft}
                  inherited={(name, priv) =>
                    owned || p.ownedObjects.includes(objKey(schema, name)) ? "as owner" : objState("tables", priv) === true ? "through “All tables”" : null
                  }
                  onGrant={() => {
                    // without USAGE the role sees nothing in the schema
                    const cur = p.granted[`schema:${schema}`] ?? [];
                    if (!owned && !cur.includes("USAGE")) setGranted(`schema:${schema}`, [...cur, "USAGE"]);
                  }}
                />
              ) : (
                <>
                  <PresetBar
                    onPick={(pr) => {
                      const [sch, tab, seq] = pgPreset(pr);
                      setDraft(
                        (d) =>
                          d && {
                            ...d,
                            privileges: {
                              ...d.privileges,
                              granted: {
                                ...d.privileges.granted,
                                [`schema:${schema}`]: sch,
                              },
                            },
                            objectTargets: {
                              ...d.objectTargets,
                              [`tables:${schema}`]: tab,
                              [`sequences:${schema}`]: seq,
                            },
                          },
                      );
                    }}
                  />
                  <PrivSection title="Schema">
                    {PG_SCHEMA_PRIVS.map((d) => {
                      const cur = p.granted[`schema:${schema}`] ?? [];
                      return (
                        <PrivCheck
                          key={d.key}
                          def={d}
                          state={cur.includes(d.key)}
                          onToggle={() => setGranted(`schema:${schema}`, cur.includes(d.key) ? cur.filter((x) => x !== d.key) : [...cur, d.key])}
                        />
                      );
                    })}
                  </PrivSection>
                  {(["tables", "sequences"] as const).map((kind) => {
                    const objs = base.objects[`${kind}:${schema}`];
                    const defs = kind === "tables" ? PG_TABLE_PRIVS : PG_SEQ_PRIVS;
                    return (
                      <PrivSection key={kind} title={`All ${kind} (${objs?.total ?? 0})`}>
                        {defs.map((d) => {
                          const st = objState(kind, d.key);
                          const n = (objs?.counts[d.key] ?? 0) + (objs?.owned ?? 0);
                          return (
                            <PrivCheck
                              key={d.key}
                              def={d}
                              state={st}
                              extra={st === "some" && !draft.objectTargets[`${kind}:${schema}`] ? `${n} of ${objs?.total} ${kind}` : undefined}
                              onToggle={() => {
                                const cur = target(kind);
                                setTarget(kind, st === true ? cur.filter((x) => x !== d.key) : [...cur.filter((x) => x !== d.key), d.key]);
                              }}
                            />
                          );
                        })}
                      </PrivSection>
                    );
                  })}
                  <Toggle
                    checked={p.futureTables.includes(schema)}
                    onChange={(v) =>
                      setDraft(
                        (d) =>
                          d && {
                            ...d,
                            privileges: {
                              ...d.privileges,
                              futureTables: v ? [...d.privileges.futureTables, schema] : d.privileges.futureTables.filter((x) => x !== schema),
                            },
                          },
                      )
                    }
                    label="Also for tables and sequences created later"
                    hint="Adds default privileges, so new tables you create in this schema get the same access."
                  />
                </>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}

/** Single tables and views: Read/Insert/Update/Delete per object. */
function ObjectsMatrix({
  scope,
  info,
  draft,
  setDraft,
  inherited,
  onGrant,
}: {
  scope: string;
  info: SchemaInfo | undefined;
  draft: Draft;
  setDraft: SetDraft;
  /** Privileges inherited from a higher level (database, "all tables", owner) and their source */
  inherited: (name: string, priv: string) => string | null;
  /** Called when a grant is added (e.g. to enable USAGE on the schema) */
  onGrant?: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [onlyGranted, setOnlyGranted] = useState(false);
  const writable = useContext(ViewWritability);
  const objects = useMemo(
    () => [
      ...(info?.tables ?? []).map((n) => ({ name: n, view: false, mat: false })),
      ...(info?.views ?? []).map((n) => ({ name: n, view: true, mat: false })),
      ...(info?.matViews ?? []).map((n) => ({ name: n, view: true, mat: true })),
    ],
    [info],
  );
  const grants = draft.privileges.objectGrants;
  const has = (name: string) => (grants[objKey(scope, name)] ?? []).length > 0;
  const visible = objects.filter((o) => o.name.toLowerCase().includes(filter.toLowerCase()) && (!onlyGranted || has(o.name)));
  const LIMIT = 300;

  const toggle = (name: string, priv: string) => {
    const key = objKey(scope, name);
    const cur = grants[key] ?? [];
    const on = !cur.includes(priv);
    setDraft(
      (d) =>
        d && {
          ...d,
          privileges: {
            ...d.privileges,
            objectGrants: {
              ...d.privileges.objectGrants,
              [key]: on ? [...cur, priv] : cur.filter((x) => x !== priv),
            },
          },
        },
    );
    if (on) onGrant?.();
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Tables & views ({objects.length})</h4>
        <div className="relative ml-auto w-48">
          <Search size={13} className="absolute left-2.5 top-[9px] text-muted" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className={cx(input, "h-7 pl-7 text-[12px]")} />
        </div>
        <button
          onClick={() => setOnlyGranted(!onlyGranted)}
          className={cx("h-7 rounded-md border px-2.5 text-[12px]", onlyGranted ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-fg-2 hover:bg-hover")}
        >
          Only with grants
        </button>
      </div>
      {objects.length === 0 ? (
        <p className="text-[12px] text-muted">No tables or views here.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full border-collapse text-[12.5px]">
            <thead className="bg-panel-2 text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Name</th>
                {OBJECT_PRIVS.map((p) => (
                  <th key={p.key} className="w-20 px-1 py-2 text-center font-semibold" title={p.hint}>
                    {p.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, LIMIT).map((o) => (
                <tr key={o.name} className="border-t border-line hover:bg-hover/40">
                  <td className="max-w-0 px-3 py-1.5">
                    <span className="flex items-center gap-2">
                      {o.view ? <Eye size={13} className="shrink-0 text-violet-300" /> : <Sheet size={13} className="shrink-0 text-muted" />}
                      <span className="truncate text-fg">{o.name}</span>
                    </span>
                  </td>
                  {OBJECT_PRIVS.map((p) => {
                    const via = inherited(o.name, p.key);
                    const on = (grants[objKey(scope, o.name)] ?? []).includes(p.key);
                    // non-updatable view: writes make no sense
                    const readOnly =
                      o.view && p.key !== "SELECT" && (o.mat || writable[objKey(scope, o.name)] === false)
                        ? o.mat
                          ? "Materialized views are read-only"
                          : "This view can't be changed (it uses GROUP BY, DISTINCT, aggregates, UNION or joins), so only Read makes sense"
                        : null;
                    if (readOnly && !on && !via)
                      return (
                        <td key={p.key} className="px-1 py-1.5 text-center" title={readOnly}>
                          <span className="mx-auto block h-px w-3 bg-line-strong" />
                        </td>
                      );
                    return (
                      <td key={p.key} className="px-1 py-1.5 text-center">
                        <button
                          disabled={!!via}
                          title={via ? `Already allowed ${via}` : `${p.hint} on ${o.name}`}
                          onClick={() => toggle(o.name, p.key)}
                          className={cx(
                            "mx-auto flex h-4 w-4 items-center justify-center rounded border",
                            via ? "border-accent/40 bg-accent/25 text-white/80" : on ? "border-accent bg-accent text-white" : "border-line-strong hover:border-accent",
                          )}
                        >
                          {(via || on) && <Check size={11} strokeWidth={3} />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length > LIMIT && <p className="border-t border-line px-3 py-2 text-[12px] text-muted">…and {visible.length - LIMIT} more, use the filter</p>}
          {visible.length === 0 && <p className="px-3 py-3 text-[12px] text-muted">{onlyGranted ? "No object-level grants here yet." : "Nothing matches the filter."}</p>}
        </div>
      )}
      <p className="mt-1.5 text-[11.5px] text-muted">Faded checkmarks are already allowed by a wider privilege above. A dash means the view is read-only, so only Read applies.</p>
    </div>
  );
}

function PrivSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h4>
      <div className="grid grid-cols-3 gap-x-2">{children}</div>
    </div>
  );
}


function ApplyDialog({
  title,
  kind,
  production,
  statements,
  onClose,
  onApply,
}: {
  title: string;
  kind: DbKind;
  production: boolean;
  statements: Stmt[];
  onClose: () => void;
  onApply: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(!production);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onApply();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} width={720}>
      <div className="space-y-3 px-5 py-4">
        {production && (
          <div className="rounded-lg border border-err/40 bg-err/10 p-3">
            <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-err">
              <TriangleAlert size={15} /> PRODUCTION database
            </div>
            <Toggle checked={ok} onChange={setOk} label="I understand this changes who can access production" />
          </div>
        )}
        <p className="text-[13px] text-fg-2">
          {statements.length} statement{statements.length === 1 ? "" : "s"}{" "}
          {kind === "postgres" ? "will run in one transaction: all succeed or nothing changes." : "will run in order. MySQL applies account changes immediately, one by one."}
        </p>
        <pre className="selectable max-h-[45vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-bg/50 p-4 font-mono text-[12.5px] leading-relaxed text-fg">
          {statements.map((s) => s.display).join(";\n") + ";"}
        </pre>
        {error && <p className="selectable rounded-md bg-err/10 px-3 py-2 text-[13px] whitespace-pre-wrap text-err">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={production ? "danger" : "primary"} disabled={busy || !ok} onClick={() => void run()}>
            {busy ? <Spinner /> : <Check size={15} />} Apply
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DropDialog({
  account,
  kind,
  production,
  currentUser,
  onClose,
  onDrop,
}: {
  account: Account;
  kind: DbKind;
  production: boolean;
  currentUser: string;
  onClose: () => void;
  onDrop: (reassignTo: string | null) => Promise<void>;
}) {
  const name = account.kind === "mysql" ? account.user : account.name;
  const [typed, setTyped] = useState("");
  const [reassign, setReassign] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stmts = dropSql(kind, account, reassign ? currentUser : null);
  return (
    <Modal title="Delete user" onClose={onClose} width={560}>
      <div className="space-y-3 px-5 py-4">
        <p className="text-[13px] text-fg-2">
          <b className="text-fg">{accountKey(account)}</b> will be deleted and can no longer log in. {production && <b className="text-err">This is a PRODUCTION database.</b>}
        </p>
        {kind === "postgres" && currentUser && (
          <Toggle
            checked={reassign}
            onChange={setReassign}
            label={`Remove its privileges and move what it owns to ${currentUser}`}
            hint="Needed when the role still has privileges or owns tables; otherwise PostgreSQL refuses to drop it."
          />
        )}
        <pre className="selectable overflow-auto rounded-md border border-line bg-bg/50 p-3 font-mono text-[12px] text-fg">{stmts.map((s) => s.display).join(";\n") + ";"}</pre>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] text-fg-2">
            Type <b className="font-mono text-fg">{name}</b> to confirm
          </span>
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className={cx(input, "font-mono")} />
        </label>
        {error && <p className="selectable rounded-md bg-err/10 px-3 py-2 text-[13px] whitespace-pre-wrap text-err">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy || typed !== name}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onDrop(reassign ? currentUser : null);
              } catch (e) {
                const msg = errorText(e);
                // 2BP01: the role still has grants or objects; enable the option that handles it
                if (kind === "postgres" && /2BP01|depend on it/.test(msg) && !reassign && currentUser) {
                  setReassign(true);
                  setError(`${msg}

The role still has privileges or owns objects. The option above is now on — click Delete again.`);
                } else setError(msg);
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : <Trash2 size={14} />} Delete user
          </Button>
        </div>
      </div>
    </Modal>
  );
}
