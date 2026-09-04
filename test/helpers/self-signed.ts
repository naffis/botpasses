/** A per-run self-signed certificate for the pinned-TLS connector tests. Needs openssl on PATH. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The hostname the certificate is issued for; tests pin it to 127.0.0.1. */
export const PINNED_HOST = "api.pinned.test";

export function selfSigned(dir: string): { key: Buffer; cert: Buffer } {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", key, "-out", cert,
      "-subj", `/CN=${PINNED_HOST}`,
      "-addext", `subjectAltName=DNS:${PINNED_HOST}`,
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
