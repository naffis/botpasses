/** Hosted boot invariants. Exit 78 = EX_CONFIG. */

export const HOSTED_CONFIG_EXIT = 78;

export function hostedBootError(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.VAULT_MODE !== "hosted") return undefined;
  if (!env.DATABASE_URL) {
    return "VAULT_MODE=hosted requires DATABASE_URL (Neon pooled).";
  }
  if (env.VAULT_HOME) {
    return "VAULT_MODE=hosted refuses VAULT_HOME; do not open sqlite on the Machine.";
  }
  if (!env.VAULT_KEK) {
    return "VAULT_MODE=hosted requires VAULT_KEK.";
  }
  if (env.RESEND_API_KEY && !env.VAULT_EMAIL_FROM?.trim()) {
    return "VAULT_MODE=hosted with RESEND_API_KEY requires VAULT_EMAIL_FROM.";
  }
  return undefined;
}

export function assertHostedBoot(env: NodeJS.ProcessEnv = process.env): void {
  const err = hostedBootError(env);
  if (err) {
    const wrapped = new Error(err);
    (wrapped as Error & { exitCode: number }).exitCode = HOSTED_CONFIG_EXIT;
    throw wrapped;
  }
}
