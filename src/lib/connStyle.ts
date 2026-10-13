// Connection colors and environments, so production stands out.
import type { ConnectionConfig } from "./api";

export const CONN_COLORS: { key: string; label: string; hex: string }[] = [
  { key: "red", label: "Red", hex: "#ef4444" },
  { key: "orange", label: "Orange", hex: "#f97316" },
  { key: "amber", label: "Amber", hex: "#eab308" },
  { key: "green", label: "Green", hex: "#22c55e" },
  { key: "teal", label: "Teal", hex: "#14b8a6" },
  { key: "blue", label: "Blue", hex: "#3b82f6" },
  { key: "purple", label: "Purple", hex: "#a855f7" },
  { key: "pink", label: "Pink", hex: "#ec4899" },
];

export type Environment = "dev" | "staging" | "production";

export const ENVIRONMENTS: { key: Environment; label: string; short: string; defaultColor: string }[] = [
  { key: "dev", label: "Development", short: "DEV", defaultColor: "green" },
  { key: "staging", label: "Staging", short: "STAGING", defaultColor: "amber" },
  { key: "production", label: "Production", short: "PROD", defaultColor: "red" },
];

export function connColor(cfg: Pick<ConnectionConfig, "color"> | undefined | null): string | null {
  return CONN_COLORS.find((c) => c.key === cfg?.color)?.hex ?? null;
}

export function connEnv(cfg: Pick<ConnectionConfig, "environment"> | undefined | null) {
  return ENVIRONMENTS.find((e) => e.key === cfg?.environment) ?? null;
}

export const isProduction = (cfg: Pick<ConnectionConfig, "environment"> | undefined | null) => cfg?.environment === "production";

/** Hex color with alpha (0..1). */
export function tint(hex: string, alpha: number) {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

const WRITE = /^(insert|update|delete|merge|replace|upsert|drop|alter|truncate|create|rename|grant|revoke|comment|call|exec|execute|do|lock|load|copy|vacuum|reindex|cluster|refresh|import)\b/i;

/** Statements that change data or structure, for the production confirmation. */
export function writeStatements(statements: string[]): string[] {
  return statements
    .map((s) => s.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim())
    .filter((s) => {
      // WITH ... (UPDATE/DELETE/INSERT) counts too
      if (/^with\b/i.test(s)) return /\b(insert|update|delete)\b/i.test(s);
      return WRITE.test(s);
    });
}
