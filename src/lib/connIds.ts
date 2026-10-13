// PostgreSQL connections without a default database show every database on the server.
// Each opened database is addressed as "<connection id>::<database>".
import type { ConnectionConfig } from "./api";

export const baseId = (id: string | null | undefined) => (id ? id.split("::")[0] : undefined);

export const dbOf = (id: string | null | undefined) => (id?.includes("::") ? id.slice(id.indexOf("::") + 2) : undefined);

export const subId = (base: string, database: string) => `${base}::${database}`;

export const isMultiDb = (cfg: ConnectionConfig | undefined) => cfg?.kind === "postgres" && !cfg.database.trim();
