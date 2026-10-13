// Server processes (sessions and running queries): listing and stopping, MySQL and PostgreSQL.
import { api, type DbKind } from "./api";

export interface Proc {
  pid: number;
  user: string;
  database: string;
  client: string;
  /** PostgreSQL application_name */
  app: string;
  state: string;
  /** Wait event (lock, I/O...) */
  wait: string;
  /** Seconds in the current query or state */
  seconds: number;
  /** PostgreSQL: transaction age */
  txSeconds: number | null;
  query: string;
  /** PostgreSQL: blocking PIDs */
  blockedBy: number[];
  /** The connection running this listing */
  self: boolean;
  /** Opened by this app (application_name "DB Client") */
  ours: boolean;
  /** Background process (replication, autovacuum, event scheduler...) */
  system: boolean;
}

const num = (v: string | null) => (v == null || v === "" ? 0 : Number(v));

export async function listProcesses(connId: string, kind: DbKind, showSystem: boolean): Promise<Proc[]> {
  const sql =
    kind === "mysql"
      ? // information_schema rather than SHOW PROCESSLIST so CONNECTION_ID() can be compared
        `SELECT p.ID, p.USER, IFNULL(p.DB, ''), p.HOST, p.COMMAND, IFNULL(p.STATE, ''), p.TIME, IFNULL(p.INFO, ''), p.ID = CONNECTION_ID()
           FROM information_schema.PROCESSLIST p ORDER BY p.TIME DESC`
      : `SELECT pid, COALESCE(usename, ''), COALESCE(datname, ''), COALESCE(host(client_addr), CASE WHEN client_port = -1 THEN 'local socket' ELSE '' END),
                COALESCE(application_name, ''), COALESCE(state, backend_type),
                COALESCE(wait_event_type || ': ' || wait_event, ''),
                EXTRACT(EPOCH FROM now() - COALESCE(CASE WHEN state = 'active' THEN query_start END, state_change, backend_start)),
                EXTRACT(EPOCH FROM now() - xact_start),
                COALESCE(query, ''), array_to_string(pg_blocking_pids(pid), ','), pid = pg_backend_pid(), backend_type <> 'client backend'
           FROM pg_stat_activity
          ${showSystem ? "" : "WHERE backend_type = 'client backend'"}
          ORDER BY 8 DESC NULLS LAST`;
  const out = await api.runQuery(connId, crypto.randomUUID(), sql, 10000);
  const rows = out.resultSets.find((r) => r.returnsRows)?.rows ?? [];
  if (kind === "mysql") {
    return rows
      .map((r) => {
        const command = r[4] ?? "";
        const system = r[1] === "event_scheduler" || r[1] === "system user" || command === "Daemon" || command.startsWith("Binlog");
        return {
          pid: num(r[0]),
          user: r[1] ?? "",
          database: r[2] ?? "",
          client: r[3] ?? "",
          app: "",
          state: command === "Query" ? "active" : command === "Sleep" ? "idle" : command,
          wait: r[5] ?? "",
          seconds: num(r[6]),
          txSeconds: null,
          query: r[7] ?? "",
          blockedBy: [],
          self: r[8] === "1",
          ours: r[8] === "1",
          system,
        };
      })
      .filter((p) => showSystem || !p.system);
  }
  return rows.map((r) => ({
    pid: num(r[0]),
    user: r[1] ?? "",
    database: r[2] ?? "",
    client: r[3] ?? "",
    app: r[4] ?? "",
    state: r[5] ?? "",
    wait: r[6] ?? "",
    seconds: num(r[7]),
    txSeconds: r[8] == null ? null : num(r[8]),
    query: r[9] ?? "",
    blockedBy: r[10] ? r[10].split(",").map(Number) : [],
    self: r[11] === "t" || r[11] === "true",
    ours: r[4] === "DB Client",
    system: r[12] === "t" || r[12] === "true",
  }));
}

/** Cancels the query only, or terminates the connection. */
export async function stopProcess(connId: string, kind: DbKind, pid: number, what: "query" | "connection"): Promise<void> {
  const sql =
    kind === "mysql"
      ? `KILL ${what === "query" ? "QUERY " : ""}${Math.trunc(pid)}`
      : `SELECT ${what === "query" ? "pg_cancel_backend" : "pg_terminate_backend"}(${Math.trunc(pid)})`;
  const out = await api.runQuery(connId, crypto.randomUUID(), sql, 1);
  const ok = out.resultSets.find((r) => r.returnsRows)?.rows[0]?.[0];
  if (kind === "postgres" && ok !== "t" && ok !== "true") throw new Error("The server did not stop the process (it may have already finished, or you lack the rights).");
}

export function fmtDuration(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const isActive = (p: Proc) => p.state === "active" || p.state === "Query" || p.state === "Execute";
export const isIdle = (p: Proc) => p.state === "idle" || p.state === "Sleep";
