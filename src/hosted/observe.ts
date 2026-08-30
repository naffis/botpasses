export function logVaultEvent(event: string, fields: Record<string, unknown>): void {
  const safe = { ...fields };
  for (const key of Object.keys(safe)) {
    if (key === "value" || key === "password" || key === "code" || key === "token") {
      delete safe[key];
    }
  }
  console.error(JSON.stringify({ event, ...safe, at: new Date().toISOString() }));
}

export async function captureException(err: unknown): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  const message = err instanceof Error ? err.message : String(err);
  logVaultEvent("exception", { message: message.slice(0, 500) });
  if (!dsn) return;
  try {
    const url = sentryStoreUrl(dsn);
    if (!url) return;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: message.slice(0, 500),
        level: "error",
        platform: "node",
      }),
    });
  } catch {
    logVaultEvent("sentry_send_failed", {});
  }
}

function sentryStoreUrl(dsn: string): string | undefined {
  try {
    const u = new URL(dsn);
    const key = u.username;
    const project = u.pathname.replace(/^\//, "");
    if (!key || !project) return undefined;
    return `${u.protocol}//${u.host}/api/${project}/store/?sentry_key=${encodeURIComponent(key)}`;
  } catch {
    return undefined;
  }
}
