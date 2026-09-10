import { resolve } from "node:path";
import { deployPlaneRaw } from "../brand.ts";
import { PostgresStore } from "../store/postgres.ts";
import { openHostedSqlite } from "../store/sqlite-hosted.ts";
import type { VaultStore } from "../store/types.ts";

/**
 * Staging/production always have a Postgres URL after `hostedBootError`.
 * Plane `dev` opens sqlite-hosted when `DATABASE_URL` is unset.
 */
export async function openHostedStore(env: NodeJS.ProcessEnv): Promise<VaultStore> {
  const url = env.DATABASE_URL?.trim();
  const plane = deployPlaneRaw(env);
  if (url) {
    return PostgresStore.open(url, { plane: plane ?? "staging" });
  }
  if (plane !== "dev") {
    throw new Error("VAULT_MODE=hosted requires DATABASE_URL (Postgres URL).");
  }
  const path = env.VAULT_HOSTED_SQLITE?.trim() || resolve(process.cwd(), ".botpasses-hosted/hosted.sqlite");
  return openHostedSqlite(path);
}
