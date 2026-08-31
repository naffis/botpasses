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
  const bootstrap = env.VAULT_BOOTSTRAP_TOKEN?.trim() ?? "";
  if (bootstrap.length > 0 && bootstrap.length < 32) {
    return "VAULT_BOOTSTRAP_TOKEN must be at least 32 characters when set.";
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
