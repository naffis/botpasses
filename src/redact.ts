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

const OAUTH_TOKEN_RE = /"(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*"[^"]*"/g;

/** Replace token fields in an origin JSON body. Never emit the raw value. */
export function redactOauthJson(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return body;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return body.replace(OAUTH_TOKEN_RE, (m) => m.replace(/:"[^"]*"$/, ':"[redacted]"'));
    }
    const out: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    for (const key of Object.keys(out)) {
      if (OAUTH_TOKEN_KEYS.has(key.toLowerCase()) && typeof out[key] === "string") {
        out[key] = "[redacted]";
      }
    }
    return JSON.stringify(out);
  } catch {
    return body.replace(OAUTH_TOKEN_RE, (m) => m.replace(/:"[^"]*"$/, ':"[redacted]"'));
  }
}

export function containsSecret(haystack: string, secret: string): boolean {
  return secret.length > 0 && haystack.includes(secret);
}

export function serializePublic(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

export function assertNoSecret(
  surface: string,
  payload: unknown,
  secrets: readonly string[],
): void {
  const blob = serializePublic(payload);
  for (const secret of secrets) {
    if (containsSecret(blob, secret)) {
      throw new Error(`Refusing to emit a secret value on surface: ${surface}`);
    }
  }
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

export function transcriptContainsSecret(
  transcript: unknown,
  secret: string,
): boolean {
  return containsSecret(serializePublic(transcript), secret);
}
