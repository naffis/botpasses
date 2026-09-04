/**
 * Request-body signing for `hmac:<scheme>` items. The secret never leaves the process; only a
 * MAC over the body (and a timestamp) is sent, in the header layout each vendor verifies.
 */
import { createHmac } from "node:crypto";
import type { HmacScheme } from "../../hosted-types.ts";

function mac(algorithm: "sha256" | "sha1", secret: string, message: string): string {
  return createHmac(algorithm, secret).update(message, "utf8").digest("hex");
}

/**
 * Headers for one scheme over `body` (the exact bytes that will be sent; "" when there is none).
 *
 * - `stripe_sig`: Stripe webhook signature. `t` is unix seconds; the signed payload is
 *   `${t}.${body}`; `v1` is hex HMAC-SHA256. Header `Stripe-Signature: t=<t>,v1=<sig>`.
 * - `slack_sig`: Slack request signing. Base string `v0:${t}:${body}` with `t` in unix seconds;
 *   headers `X-Slack-Request-Timestamp: <t>` and `X-Slack-Signature: v0=<hex HMAC-SHA256>`.
 * - `github_sig`: GitHub webhook signature. `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(body)>`
 *   plus the legacy `X-Hub-Signature: sha1=<hex HMAC-SHA1(body)>`.
 */
export function hmacSignatureHeaders(
  scheme: HmacScheme,
  secret: string,
  body: string,
  now: Date,
): Record<string, string> {
  const t = Math.floor(now.getTime() / 1000);
  switch (scheme) {
    case "stripe_sig":
      return { "stripe-signature": `t=${t},v1=${mac("sha256", secret, `${t}.${body}`)}` };
    case "slack_sig":
      return {
        "x-slack-request-timestamp": String(t),
        "x-slack-signature": `v0=${mac("sha256", secret, `v0:${t}:${body}`)}`,
      };
    case "github_sig":
      return {
        "x-hub-signature-256": `sha256=${mac("sha256", secret, body)}`,
        "x-hub-signature": `sha1=${mac("sha1", secret, body)}`,
      };
    default: {
      const _exhaustive: never = scheme;
      throw new Error(`Unhandled HMAC scheme: ${String(_exhaustive)}`);
    }
  }
}
