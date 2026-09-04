const FORBIDDEN_RESULT_KEYS = new Set([
  "value",
  "plaintext",
  "password",
  "token",
  "secret",
  "secret_value",
  "ciphertext_plain",
]);

const OAUTH_TOKEN_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
]);

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenKeyRe(keys: ReadonlySet<string>): RegExp {
  return new RegExp(`"(?:${[...keys].map(escapeRe).join("|")})"\\s*:\\s*"[^"]*"`, "gi");
}

function redactOauthTree(node: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => redactOauthTree(n, keys));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] =
      keys.has(key.toLowerCase()) && typeof value === "string"
        ? "[redacted]"
        : redactOauthTree(value, keys);
  }
  return out;
}

/**
 * Replace token fields anywhere in an origin JSON body (nested objects and arrays included).
 * Non-JSON bodies get a structural regex pass over `"access_token": "..."` shapes. `extraKeys`
 * adds a provider's own token field names to the standard OAuth set.
 */
export function redactOauthJson(body: string, extraKeys: readonly string[] = []): string {
  const trimmed = body.trim();
  if (!trimmed) return body;
  const keys = new Set([...OAUTH_TOKEN_KEYS, ...extraKeys.map((k) => k.toLowerCase())]);
  const re = tokenKeyRe(keys);
  const textual = () => body.replace(re, (m) => m.replace(/:\s*"[^"]*"$/, ':"[redacted]"'));
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return textual();
    return JSON.stringify(redactOauthTree(parsed, keys));
  } catch {
    return textual();
  }
}

/** Shortest derived encoding still worth matching; shorter forms mangle dates and ids. */
const MIN_DERIVED_LEN = 8;

/**
 * Every encoding of a credential an origin could echo back: raw, HTTP Basic base64 of
 * `user:secret`, base64 of the secret, URL-encoded, JSON-escaped, and hex. The raw secret is
 * always included; derived forms only when they are long enough to be unambiguous.
 */
export function secretEncodings(secret: string, username?: string | null): string[] {
  if (secret.length === 0) return [];
  const forms = new Set<string>([secret]);
  const derived = [
    Buffer.from(`${username ?? ""}:${secret}`).toString("base64"),
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    Buffer.from(secret, "utf8").toString("hex"),
  ];
  for (const form of derived) {
    if (form.length >= MIN_DERIVED_LEN) forms.add(form);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Replace every encoding of every secret with `[redacted]`. Longest forms first. */
export function redactSecrets(body: string, secrets: readonly string[]): string {
  let out = body;
  for (const form of [...secrets].sort((a, b) => b.length - a.length)) {
    if (form.length > 0) out = out.split(form).join("[redacted]");
  }
  return out;
}

export function assertSafePublicObject(surface: string, obj: unknown): void {
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_RESULT_KEYS.has(key.toLowerCase())) {
        throw new Error(`Unsafe key ${path}.${key} on ${surface}`);
      }
      walk(value, `${path}.${key}`);
    }
  };
  walk(obj, "$");
}

function containsSecret(haystack: string, secret: string): boolean {
  return secret.length > 0 && haystack.includes(secret);
}

function serializePublic(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

export function transcriptContainsSecret(
  transcript: unknown,
  secret: string,
): boolean {
  return containsSecret(serializePublic(transcript), secret);
}
