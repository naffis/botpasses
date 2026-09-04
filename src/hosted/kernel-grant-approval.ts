/**
 * How an operator learns about and answers a grant request: the 8-digit code challenge, the
 * HMAC magic link, and the approval email. `kernel-grants.ts` calls these from `requestGrant`,
 * `approveByCode`, and `approveMagic`; the `GrantHost` it passes is the same object.
 */
import { createHmac, createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { assertSafePublicObject } from "../redact.ts";
import type { ClientRecord, HostedGrantRecord, RequestedScope } from "../hosted-types.ts";
import { escapeHtml } from "./auth-shell.ts";
import { HttpError } from "./errors.ts";
import type { GrantHost } from "./kernel-grants.ts";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAGIC_TTL_MS = 15 * 60 * 1000;

export type MagicPreview = {
  grant_id: string;
  client_name: string;
  item_name: string;
  item_last4: string;
  policy: string;
  task_description: string | null;
  requested_scope: RequestedScope | null;
};

export function isPast(iso: string | null, now: Date): boolean {
  return iso !== null && new Date(iso).getTime() < now.getTime();
}

export function hashCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

/**
 * Replaces the grant's code challenge with a fresh 8-digit code and returns the plaintext. The
 * wrong-code count carries over from the challenge it replaces, so re-requesting the grant
 * does not hand a guesser five fresh attempts per rotation.
 */
export async function rotateCodeChallenge(host: GrantHost, grantId: string, now: Date): Promise<string> {
  const prior = await host.store.getChallengeByGrantKind(grantId, "code");
  if (prior) await host.store.deleteChallenge(prior.id);
  const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
  const salt = randomBytes(8).toString("hex");
  await host.store.insertChallenge({
    id: `chl_${randomUUID()}`,
    grantId,
    codeHash: `${salt}:${hashCode(code, salt)}`,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    attempts: prior?.attempts ?? 0,
    kind: "code",
  });
  return code;
}

/** Keeps an unexpired magic link; mints a new one otherwise. `fresh` means a new link was made. */
export async function ensureMagicChallenge(
  host: GrantHost,
  grantId: string,
  now: Date,
): Promise<{ token?: string; fresh: boolean }> {
  if (!host.approvalHmac) return { fresh: true };
  const prior = await host.store.getChallengeByGrantKind(grantId, "magic");
  if (prior && !isPast(prior.expiresAt, now)) return { token: prior.codeHash, fresh: false };
  if (prior) await host.store.deleteChallenge(prior.id);
  const exp = now.getTime() + MAGIC_TTL_MS;
  const token = mintApprovalToken(host.approvalHmac, grantId, exp);
  await host.store.insertChallenge({
    id: `chl_${randomUUID()}`,
    grantId,
    codeHash: token,
    expiresAt: new Date(exp).toISOString(),
    attempts: 0,
    kind: "magic",
  });
  return { token, fresh: true };
}

/** An explicit `operatorEmail` wins; otherwise every member with a verified email is notified. */
export async function notifyRecipients(host: GrantHost, orgId: string, operatorEmail: string | undefined): Promise<string[]> {
  if (operatorEmail !== undefined) return [operatorEmail.trim().toLowerCase()];
  return host.store.listMemberEmails(orgId);
}

/** REST boundary check for `operator_email`: only this org's members may be addressed. */
export async function assertMemberEmail(host: GrantHost, orgId: string, email: string): Promise<string> {
  const wanted = email.trim().toLowerCase();
  const members = await host.store.listMemberEmails(orgId);
  if (!members.some((m) => m.toLowerCase() === wanted)) {
    throw new HttpError(400, "operator_email must be a member of this org");
  }
  return wanted;
}

/** Sends the approval email to each recipient. True when at least one send succeeded. */
export async function notify(
  host: GrantHost,
  orgId: string,
  recipients: string[],
  client: ClientRecord,
  item: { name: string; last4: string },
  magicToken: string | undefined,
): Promise<boolean> {
  let sent = 0;
  if (host.sendEmail && recipients.length > 0) {
    const link = magicToken
      ? `${host.publicUrl}/approve?token=${encodeURIComponent(magicToken)}`
      : `${host.publicUrl.replace(/\/$/, "")}/console`;
    const html =
      `<p>Client ${escapeHtml(client.name)} requested ${escapeHtml(item.name)} (••••${escapeHtml(item.last4)}).</p>` +
      `<p>Approve in inbox or use the code in the agent result.</p>` +
      `<p><a href="${escapeHtml(link)}">Approve</a></p>`;
    for (const to of recipients) {
      try {
        await host.sendEmail(to, `Grant request ${item.name}`, html);
        sent += 1;
      } catch {
        // counted below
      }
    }
  }
  if (sent === 0) {
    await host.audit(orgId, "notify_failed", "system", item.name, client.id);
    return false;
  }
  return true;
}

/** The pending grant a magic link points at, once the link and its stored challenge check out. */
export async function magicGrant(host: GrantHost, orgId: string, token: string): Promise<HostedGrantRecord> {
  if (!host.approvalHmac) throw new HttpError(500, "Magic links are not configured");
  const grantId = verifyApprovalToken(host.approvalHmac, token, host.now().getTime());
  const grant = await host.store.getGrant(grantId);
  if (!grant || grant.orgId !== orgId) throw new HttpError(404, "Unknown grant");
  if (grant.status !== "pending") throw new HttpError(410, "Expired link");
  const magic = await host.store.getChallengeByGrantKind(grantId, "magic");
  if (!magic || magic.codeHash !== token) throw new HttpError(410, "Expired link");
  return grant;
}

/** Validates a magic link and returns what approving it would do. No state change. */
export async function previewMagic(host: GrantHost, orgId: string, token: string): Promise<MagicPreview> {
  const grant = await magicGrant(host, orgId, token);
  const item = grant.itemId ? await host.store.getItem(grant.itemId) : undefined;
  const client = await host.store.getClient(grant.clientId);
  const preview: MagicPreview = {
    grant_id: grant.id,
    client_name: client?.name ?? "agent",
    item_name: item?.name ?? "",
    item_last4: item?.last4 ?? "",
    policy: "prompt",
    task_description: grant.taskDescription,
    requested_scope: grant.requestedScope,
  };
  assertSafePublicObject("previewMagic", preview);
  return preview;
}

export function mintApprovalToken(hmac: Buffer, grantId: string, expMs: number): string {
  const body = Buffer.from(JSON.stringify({ grantId, exp: expMs })).toString("base64url");
  const sig = createHmac("sha256", hmac).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyApprovalToken(hmac: Buffer, token: string, nowMs: number): string {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new HttpError(410, "Invalid link");
  const expected = createHmac("sha256", hmac).update(body).digest("base64url");
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    throw new HttpError(410, "Invalid link");
  }
  const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new HttpError(410, "Invalid link");
  const rec = parsed as { grantId?: unknown; exp?: unknown };
  if (typeof rec.grantId !== "string" || typeof rec.exp !== "number") {
    throw new HttpError(410, "Invalid link");
  }
  if (rec.exp < nowMs) throw new HttpError(410, "Expired link");
  return rec.grantId;
}
