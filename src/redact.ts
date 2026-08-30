const FORBIDDEN_RESULT_KEYS = new Set([
  "value",
  "plaintext",
  "password",
  "token",
  "secret_value",
  "ciphertext_plain",
]);

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
