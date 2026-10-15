// PostgreSQL CREATE DATABASE with a template and the options that can only be set at creation.
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { api, errorText } from "../lib/api";
import { useStore } from "../store";
import { baseId, subId } from "../lib/connIds";
import { isProduction } from "../lib/connStyle";
import { pushToast } from "../lib/importJobs";
import { Button, cx, Modal, Spinner } from "./ui";
import { field } from "./ConnectionDialog";
import { Field, Toggle } from "./UsersDialog";
import { Combo, Select } from "./Select";

const ENCODINGS = [
  "UTF8", "SQL_ASCII", "LATIN1", "LATIN2", "LATIN3", "LATIN4", "LATIN5", "LATIN6", "LATIN7", "LATIN8", "LATIN9", "LATIN10",
  "WIN1250", "WIN1251", "WIN1252", "WIN1253", "WIN1254", "WIN1255", "WIN1256", "WIN1257", "WIN1258", "WIN866", "WIN874",
  "ISO_8859_5", "ISO_8859_6", "ISO_8859_7", "ISO_8859_8", "KOI8R", "KOI8U", "EUC_CN", "EUC_JP", "EUC_JIS_2004", "EUC_KR", "EUC_TW", "MULE_INTERNAL",
];

interface SourceDb {
  name: string;
  isTemplate: boolean;
  encoding: string;
  collate: string;
  sessions: number;
}

interface ServerData {
  version: number;
  user: string;
  dbs: SourceDb[];
  roles: string[];
  tablespaces: string[];
  libcLocales: string[];
  icuLocales: string[];
}

type Provider = "" | "libc" | "icu" | "builtin";

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function rows(connId: string, sql: string) {
  const out = await api.runQuery(connId, crypto.randomUUID(), sql, 100000);
  return out.resultSets.find((r) => r.returnsRows)?.rows ?? [];
}

async function loadServer(connId: string): Promise<ServerData> {
  const [info] = await rows(connId, "SELECT current_setting('server_version_num'), current_user");
  const version = Number(info[0]);
  const icuCol = version >= 170000 ? "colllocale" : version >= 150000 ? "colliculocale" : "collcollate";
  const [dbs, roles, tablespaces, libc, icu] = await Promise.all([
    rows(
      connId,
      `SELECT d.datname, d.datistemplate::text, pg_encoding_to_char(d.encoding), d.datcollate,
              (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname AND a.pid <> pg_backend_pid())::text
         FROM pg_database d
        ORDER BY d.datistemplate DESC, d.datname`,
    ),
    rows(connId, "SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1"),
    rows(connId, "SELECT spcname FROM pg_tablespace WHERE spcname <> 'pg_global' ORDER BY 1"),
    rows(connId, "SELECT DISTINCT collcollate FROM pg_collation WHERE collprovider = 'c' AND collcollate IS NOT NULL ORDER BY 1"),
    rows(connId, `SELECT DISTINCT ${icuCol} FROM pg_collation WHERE collprovider = 'i' AND ${icuCol} IS NOT NULL ORDER BY 1`),
  ]);
  return {
    version,
    user: info[1] ?? "",
    dbs: dbs.map((r) => ({ name: r[0]!, isTemplate: r[1] === "true", encoding: r[2] ?? "", collate: r[3] ?? "", sessions: Number(r[4]) })),
    roles: roles.map((r) => r[0]!),
    tablespaces: tablespaces.map((r) => r[0]!),
    libcLocales: libc.map((r) => r[0]!),
    icuLocales: icu.map((r) => r[0]!),
  };
}

interface Form {
  name: string;
  template: string;
  owner: string;
  encoding: string;
  provider: Provider;
  lcCollate: string;
  lcCtype: string;
  icuLocale: string;
  icuRules: string;
  builtinLocale: string;
  strategy: "" | "wal_log" | "file_copy";
  tablespace: string;
  connLimit: string;
  isTemplate: boolean;
  comment: string;
}

const EMPTY: Form = {
  name: "",
  template: "template1",
  owner: "",
  encoding: "",
  provider: "",
  lcCollate: "",
  lcCtype: "",
  icuLocale: "",
  icuRules: "",
  builtinLocale: "C.UTF-8",
  strategy: "",
  tablespace: "",
  connLimit: "",
  isTemplate: false,
  comment: "",
};

function createSql(f: Form) {
  const opts: string[] = [];
  if (f.owner) opts.push(`OWNER = ${ident(f.owner)}`);
  if (f.template !== "template1") opts.push(`TEMPLATE = ${ident(f.template)}`);
  if (f.encoding) opts.push(`ENCODING = ${lit(f.encoding)}`);
  if (f.provider) opts.push(`LOCALE_PROVIDER = ${f.provider}`);
  if (f.provider === "icu" && f.icuLocale.trim()) opts.push(`ICU_LOCALE = ${lit(f.icuLocale.trim())}`);
  if (f.provider === "icu" && f.icuRules.trim()) opts.push(`ICU_RULES = ${lit(f.icuRules.trim())}`);
  if (f.provider === "builtin") opts.push(`BUILTIN_LOCALE = ${lit(f.builtinLocale)}`);
  if (f.lcCollate.trim()) opts.push(`LC_COLLATE = ${lit(f.lcCollate.trim())}`);
  if (f.lcCtype.trim()) opts.push(`LC_CTYPE = ${lit(f.lcCtype.trim())}`);
  if (f.strategy) opts.push(`STRATEGY = ${f.strategy}`);
  if (f.tablespace) opts.push(`TABLESPACE = ${ident(f.tablespace)}`);
  if (f.connLimit.trim()) opts.push(`CONNECTION LIMIT = ${Number(f.connLimit)}`);
  if (f.isTemplate) opts.push("IS_TEMPLATE = true");
  const name = ident(f.name.trim() || "new_database");
  return opts.length ? `CREATE DATABASE ${name}\n  WITH ${opts.join("\n       ")};` : `CREATE DATABASE ${name};`;
}

export function CreateDatabaseHost() {
  const dlg = useStore((s) => s.createDbDialog);
  if (!dlg) return null;
  return <CreateDatabaseDialog key={dlg.connId} connId={dlg.connId} />;
}

function CreateDatabaseDialog({ connId }: { connId: string }) {
  const close = () => useStore.getState().setUi({ createDbDialog: null });
  const prod = isProduction(useStore.getState().connections.find((c) => c.id === baseId(connId)));
  const [data, setData] = useState<ServerData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [f, setF] = useState<Form>(EMPTY);
  const [advanced, setAdvanced] = useState(false);
  const [autoTemplate0, setAutoTemplate0] = useState(false);
  const [terminate, setTerminate] = useState(false);
  const [acked, setAcked] = useState(false);
  const [connect, setConnect] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadServer(connId).then(setData, (e) => setLoadError(errorText(e)));
  }, [connId]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  // template1 only allows its own encoding and locale; template0 accepts any
  const setLocale = <K extends keyof Form>(k: K, v: Form[K]) => {
    if (f.template === "template1" && v) {
      setAutoTemplate0(true);
      setF((p) => ({ ...p, [k]: v, template: "template0" }));
    } else set(k, v);
  };

  const v = data?.version ?? 0;
  const source = data?.dbs.find((d) => d.name === f.template);
  const copying = !!source && !source.isTemplate;
  const busy = (source?.sessions ?? 0) > 0 && f.template !== "template0";
  const sql = useMemo(() => createSql(f), [f]);
  const nameTaken = !!data?.dbs.some((d) => d.name === f.name.trim());
  const canRun = !running && !!data && !!f.name.trim() && !nameTaken && (!terminate || !prod || acked);

  const run = async () => {
    setRunning(true);
    setError(null);
    const name = f.name.trim();
    const st = useStore.getState();
    try {
      if (terminate && busy) {
        const ownId = subId(connId, f.template);
        if (st.conn[ownId]) await st.disconnectFrom(ownId);
        await api.runQuery(connId, crypto.randomUUID(), `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${lit(f.template)} AND pid <> pg_backend_pid();`, 10);
      }
      // CREATE DATABASE can't share a batch (implicit transaction) with anything else
      await api.runQuery(connId, crypto.randomUUID(), sql, 10);
      if (f.comment.trim()) await api.runQuery(connId, crypto.randomUUID(), `COMMENT ON DATABASE ${ident(name)} IS ${lit(f.comment.trim())};`, 10);
    } catch (e) {
      const msg = errorText(e);
      if (useStore.getState().createDbDialog?.connId === connId) {
        setError(msg);
        setRunning(false);
      } else pushToast("error", `Creating database ${name} failed`, msg);
      return;
    }
    const open = useStore.getState().createDbDialog?.connId === connId;
    if (open) close();
    else pushToast("ok", `Database ${name} created`, copying ? `Copied from ${f.template}.` : "");
    void st.loadDatabases(connId);
    if (connect) {
      const id = subId(connId, name);
      if (await st.connectTo(id)) st.newTab({ connId: id, title: `${name}.sql` });
    }
  };

  const tplLabel = (d: SourceDb) =>
    d.name === "template1" ? "template1 (default)" : d.name === "template0" ? "template0 (clean, any encoding or locale)" : d.name;

  return (
    <Modal title="Create database" onClose={close} width={620}>
      <form
        className="space-y-4 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canRun) void run();
        }}
      >
        {prod && (
          <p className="flex items-center gap-2 rounded-md bg-err/15 px-3 py-2 text-[13px] font-medium text-err">
            <TriangleAlert size={15} /> This runs on a PRODUCTION server.
          </p>
        )}
        {loadError && <p className="selectable rounded-md bg-err/10 px-3 py-2 text-[13px] text-err">{loadError}</p>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" hint={nameTaken ? "A database with this name already exists." : undefined}>
            <input autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} spellCheck={false} className={field} />
          </Field>
          <Field label="Owner">
            <Select
              value={f.owner}
              onChange={(o) => set("owner", o)}
              disabled={!data}
              options={[{ value: "", label: data ? data.user : "…", hint: "you" }, ...(data?.roles.filter((r) => r !== data.user).map((r) => ({ value: r })) ?? [])]}
            />
          </Field>
        </div>

        <Field
          label="Template"
          hint={
            autoTemplate0 && f.template === "template0"
              ? "Switched to template0: template1 only allows its own encoding and locale."
              : copying
                ? "Copies the whole database: schemas, data, extensions and privileges."
                : source
                  ? `${source.encoding} · ${source.collate}`
                  : undefined
          }
        >
          <Select
            value={f.template}
            disabled={!data}
            onChange={(t) => {
              setAutoTemplate0(false);
              setTerminate(false);
              set("template", t);
            }}
            options={
              data
                ? data.dbs.map((d) => ({
                    value: d.name,
                    label: tplLabel(d),
                    group: d.isTemplate ? "Templates" : "Copy a database",
                    hint: d.sessions ? `${d.sessions} session${d.sessions === 1 ? "" : "s"}` : undefined,
                  }))
                : [{ value: "template1", label: "template1 (default)" }]
            }
          />
        </Field>

        {busy && (
          <div className="space-y-2.5 rounded-md border border-warn/40 bg-warn/10 px-3 py-2.5">
            <p className="flex items-start gap-2 text-[13px] text-fg">
              <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" />
              "{f.template}" has {source!.sessions} active session{source!.sessions === 1 ? "" : "s"}. PostgreSQL can't copy a database while anyone is connected to it.
            </p>
            <Toggle checked={terminate} onChange={setTerminate} danger label={`Terminate all sessions on "${f.template}" first`} hint="Other users and applications are disconnected; their open transactions are rolled back." />
            {terminate && prod && (
              <label className="flex items-start gap-2 text-[13px] text-fg">
                <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />I understand that all sessions on the production database "{f.template}" will be terminated.
              </label>
            )}
          </div>
        )}

        <button type="button" onClick={() => setAdvanced(!advanced)} className="flex items-center gap-1.5 text-[13px] font-medium text-fg-2 hover:text-fg">
          <ChevronRight size={15} className={cx("transition-transform", advanced && "rotate-90")} />
          Encoding, locale and more
        </button>

        {advanced && (
          <div className="space-y-4 border-l-2 border-line pl-4">
            <p className="text-[12px] text-muted">Encoding, locale and strategy can only be set now; changing them later means creating a new database.</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Encoding">
                <Select value={f.encoding} onChange={(e) => setLocale("encoding", e)} options={[{ value: "", label: "Same as template" }, ...ENCODINGS.map((e) => ({ value: e }))]} />
              </Field>
              <Field label="Locale provider" hint={f.provider === "icu" ? "Same sort order on every OS; collations survive OS upgrades." : f.provider === "builtin" ? "Fast, OS-independent; code point order." : undefined}>
                <Select
                  value={f.provider}
                  onChange={(p) => setLocale("provider", p as Provider)}
                  options={[
                    { value: "", label: "Same as template" },
                    { value: "libc", label: "libc", hint: "operating system" },
                    ...(v >= 150000 ? [{ value: "icu", label: "ICU" }] : []),
                    ...(v >= 170000 ? [{ value: "builtin", label: "builtin", hint: "PostgreSQL 17+" }] : []),
                  ]}
                />
              </Field>
              {f.provider === "icu" && (
                <Field label="ICU locale" hint="e.g. sr-Latn-RS, en-US, und-u-ks-level2 (case-insensitive)">
                  <Combo value={f.icuLocale} onChange={(l) => set("icuLocale", l)} suggestions={data?.icuLocales ?? []} placeholder="und" />
                </Field>
              )}
              {f.provider === "icu" && v >= 160000 && (
                <Field label="ICU rules" hint="Custom tailoring, e.g. &a < g">
                  <input value={f.icuRules} onChange={(e) => set("icuRules", e.target.value)} spellCheck={false} className={field} />
                </Field>
              )}
              {f.provider === "builtin" && (
                <Field label="Builtin locale">
                  <Select
                    value={f.builtinLocale}
                    onChange={(l) => set("builtinLocale", l)}
                    options={[{ value: "C.UTF-8" }, { value: "C" }, ...(v >= 180000 ? [{ value: "PG_UNICODE_FAST" }] : [])]}
                  />
                </Field>
              )}
              <Field label="Collation (LC_COLLATE)" hint="Sort order of text">
                <Combo value={f.lcCollate} onChange={(l) => setLocale("lcCollate", l)} suggestions={data?.libcLocales ?? []} placeholder="Same as template" />
              </Field>
              <Field label="Character type (LC_CTYPE)" hint="Upper/lower case, character classes">
                <Combo value={f.lcCtype} onChange={(l) => setLocale("lcCtype", l)} suggestions={data?.libcLocales ?? []} placeholder="Same as template" />
              </Field>
              {v >= 150000 && (
                <Field label="Strategy" hint={f.strategy === "file_copy" ? "Copies files directly: faster for a large template, but forces a checkpoint." : "WAL_LOG copies block by block; best for small templates."}>
                  <Select
                    value={f.strategy}
                    onChange={(s) => set("strategy", s as Form["strategy"])}
                    options={[
                      { value: "", label: "WAL_LOG", hint: "default" },
                      { value: "file_copy", label: "FILE_COPY" },
                    ]}
                  />
                </Field>
              )}
              <Field label="Tablespace">
                <Select
                  value={f.tablespace}
                  onChange={(t) => set("tablespace", t)}
                  options={[{ value: "", label: "pg_default", hint: "default" }, ...(data?.tablespaces.filter((t) => t !== "pg_default").map((t) => ({ value: t })) ?? [])]}
                />
              </Field>
              <Field label="Connection limit">
                <input type="number" min={-1} value={f.connLimit} onChange={(e) => set("connLimit", e.target.value)} className={field} placeholder="Unlimited" />
              </Field>
            </div>
            <Field label="Comment">
              <input value={f.comment} onChange={(e) => set("comment", e.target.value)} className={field} placeholder="What this database is for" />
            </Field>
            <Toggle checked={f.isTemplate} onChange={(c) => set("isTemplate", c)} label="Mark as template" hint="Anyone with CREATEDB can then use it as a template for new databases." />
          </div>
        )}

        <Toggle checked={connect} onChange={setConnect} label="Connect and open a query tab" />

        <pre className="selectable overflow-x-auto rounded-md border border-line bg-bg/50 p-3 font-mono text-[12px] text-fg-2">{sql}</pre>

        {error && <p className="selectable rounded-md bg-err/10 px-3 py-2 text-[13px] text-err">{error}</p>}
        <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
          {running && copying && <span className="mr-auto text-[12px] text-muted">You can close this dialog; you'll be notified when it's done.</span>}
          <Button type="button" variant="ghost" onClick={close}>
            {running ? "Close" : "Cancel"}
          </Button>
          <Button type="submit" variant="primary" disabled={!canRun}>
            {running && <Spinner />} Create database
          </Button>
        </div>
      </form>
    </Modal>
  );
}
