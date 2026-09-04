/**
 * Team and plan routes (tasks 3.7 and 3.9): members, invites, the accept-invite page, the
 * session org switcher, and the plan usage report. Mutations are owner-only and, for cookie
 * sessions, CSRF-checked upstream in http.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireOperator, type OperatorPrincipal, type Principal } from "./auth.ts";
import { authDocument, escapeAttr, escapeHtml } from "./auth-shell.ts";
import { HttpError, isHttpError } from "./errors.ts";
import { json, readJson, sendHtml } from "./http-util.ts";
import { needsTotpVerify } from "./identity.ts";
import { requestClientIp } from "./identity-limiter.ts";
import { asMemberRole, type InvitePreview } from "./kernel-members.ts";
import type { HostedKernel } from "./kernel.ts";

export type MemberRouteOpts = {
  kernel: HostedKernel;
  publicUrl: string;
  htmlHeaders: (nonce: string) => Record<string, string>;
  newCspNonce: () => string;
};

/** A cookie-backed operator session; bootstrap-token operators have no session to pin an org on. */
function requireSession(principal: Principal | undefined): OperatorPrincipal & { sessionHash: string } {
  const op = requireOperator(principal);
  if (!op.sessionHash) throw new HttpError(400, "Session required");
  return { ...op, sessionHash: op.sessionHash };
}

export async function handleMemberRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  path: string,
  principal: Principal | undefined,
  opts: MemberRouteOpts,
): Promise<boolean> {
  const { kernel } = opts;
  if (method === "GET" && path === "/accept-invite") {
    await renderAcceptPage(res, url.searchParams.get("token") ?? "", principal, opts);
    return true;
  }
  if (method === "GET" && path === "/api/members") {
    const op = requireOperator(principal);
    const team = await kernel.listTeam(op.orgId);
    json(res, 200, { ...team, org_id: op.orgId, role: op.role, user_id: op.userId });
    return true;
  }
  if (method === "POST" && path === "/api/members/invite") {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const out = await kernel.inviteMember({
      orgId: op.orgId,
      actorUserId: op.userId,
      actorRole: op.role,
      email: String(body.email ?? ""),
      role: asMemberRole(body.role ?? "operator"),
      ip: requestClientIp(req),
    });
    json(res, 200, out);
    return true;
  }
  const memberRole = /^\/api\/members\/([^/]+)\/role$/.exec(path);
  if (method === "POST" && memberRole) {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const member = await kernel.updateMemberRole({
      orgId: op.orgId,
      actorUserId: op.userId,
      actorRole: op.role,
      userId: decodeURIComponent(memberRole[1] ?? ""),
      role: asMemberRole(body.role),
    });
    json(res, 200, { member });
    return true;
  }
  const memberOne = /^\/api\/members\/([^/]+)$/.exec(path);
  if (method === "DELETE" && memberOne) {
    const op = requireOperator(principal);
    await kernel.removeMember({
      orgId: op.orgId,
      actorUserId: op.userId,
      actorRole: op.role,
      userId: decodeURIComponent(memberOne[1] ?? ""),
    });
    json(res, 200, { ok: true });
    return true;
  }
  const inviteOne = /^\/api\/invites\/([^/]+)$/.exec(path);
  if (method === "DELETE" && inviteOne) {
    const op = requireOperator(principal);
    await kernel.cancelInvite({
      orgId: op.orgId,
      actorUserId: op.userId,
      actorRole: op.role,
      inviteId: decodeURIComponent(inviteOne[1] ?? ""),
    });
    json(res, 200, { ok: true });
    return true;
  }
  if (method === "POST" && path === "/api/invites/accept") {
    const op = requireOperator(principal);
    const body = await readJson(req);
    const user = await kernel.store.getUser(op.userId);
    if (!user) throw new HttpError(401, "Authentication required");
    const joined = await kernel.acceptInvite({ userId: op.userId, email: user.email, token: String(body.token ?? "") });
    if (op.sessionHash) {
      await kernel.setActiveOrg({ userId: op.userId, sessionHash: op.sessionHash, orgId: joined.org_id });
    }
    json(res, 200, joined);
    return true;
  }
  if (method === "GET" && path === "/api/orgs") {
    const op = requireOperator(principal);
    json(res, 200, { orgs: await kernel.listOrgsForUser(op.userId, op.orgId) });
    return true;
  }
  if (method === "POST" && path === "/api/session/org") {
    const op = requireSession(principal);
    const body = await readJson(req);
    const org = await kernel.setActiveOrg({
      userId: op.userId,
      sessionHash: op.sessionHash,
      orgId: String(body.org_id ?? body.orgId ?? ""),
    });
    json(res, 200, { org });
    return true;
  }
  if (method === "GET" && path === "/api/plan") {
    const op = requireOperator(principal);
    json(res, 200, await kernel.planReport(op.orgId));
    return true;
  }
  return false;
}

/* ---------- accept page ---------- */

type Visitor =
  | { kind: "anonymous" }
  | { kind: "pending"; next: "/verify-totp" | "/enroll-totp" }
  | { kind: "ready"; email: string; hasSession: boolean };

async function visitorOf(principal: Principal | undefined, kernel: HostedKernel): Promise<Visitor> {
  if (!principal || principal.channel !== "operator") return { kind: "anonymous" };
  if (principal.ready === false) return { kind: "pending", next: needsTotpVerify(principal) ? "/verify-totp" : "/enroll-totp" };
  const user = await kernel.store.getUser(principal.userId);
  return { kind: "ready", email: user?.email ?? "", hasSession: Boolean(principal.sessionHash) };
}

async function renderAcceptPage(
  res: ServerResponse,
  token: string,
  principal: Principal | undefined,
  opts: MemberRouteOpts,
): Promise<void> {
  const nonce = opts.newCspNonce();
  const headers = opts.htmlHeaders(nonce);
  let preview: InvitePreview;
  try {
    preview = await opts.kernel.previewInvite(token);
  } catch (err) {
    if (!isHttpError(err) || err.status !== 404) throw err;
    sendHtml(
      res,
      404,
      authDocument({
        title: "Invite not found",
        testid: "accept-invite",
        script: "",
        body: `<p>This invite link is not valid. Ask the person who invited you to send a new one.</p><p><a href="/console">Go to the console</a></p>`,
      }),
      headers,
    );
    return;
  }
  const visitor = await visitorOf(principal, opts.kernel);
  sendHtml(res, 200, acceptInvitePageHtml(preview, visitor, token, nonce), headers);
}

const ACCEPT_JS = `(() => {
  const form = document.getElementById("accept-form");
  if (!form) return;
  const token = new URLSearchParams(location.search).get("token") || "";
  const csrf = () => {
    const m = document.cookie.match(/(?:^|; )(?:__Host-bp_csrf|bp_csrf)=([^;]+)/);
    return m && m[1] ? decodeURIComponent(m[1]) : "";
  };
  const flash = document.getElementById("flash");
  const say = (msg, ok) => { if (flash) { flash.textContent = msg; flash.className = ok ? "flash is-ok" : "flash is-err"; } };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button");
    if (button) button.disabled = true;
    try {
      const r = await fetch("/api/invites/accept", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "X-CSRF-Token": csrf() },
        body: JSON.stringify({ token }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        say(body.error === "invite_email_mismatch"
          ? "This invite was sent to a different email address. Sign out and sign in with the invited address."
          : (body.error || "Could not accept the invite"), false);
        if (button) button.disabled = false;
        return;
      }
      say("You joined " + (body.org_name || "the workspace") + ". Opening the console.", true);
      location.href = "/console";
    } catch {
      say("Could not reach the server. Retry.", false);
      if (button) button.disabled = false;
    }
  });
  const out = document.getElementById("accept-signout");
  if (out) out.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "X-CSRF-Token": csrf() }, body: "{}" });
    } catch {}
    location.href = "/sign-in";
  });
})();`;

/** Server-rendered: the token stays in the query so a visitor can sign in and reopen the same link. */
export function acceptInvitePageHtml(preview: InvitePreview, visitor: Visitor, token: string, nonce: string): string {
  const org = escapeHtml(preview.org_name);
  const role = escapeHtml(preview.role);
  const invited = escapeHtml(preview.email);
  const lede = `<p>You were invited to join <strong>${org}</strong> on Botpasses as <strong>${role}</strong>. The invite was sent to <strong>${invited}</strong>.</p>`;
  let action: string;
  if (preview.accepted) {
    action = `<p>This invite was already used.</p><p><a class="btn-primary" href="/console">Open the console</a></p>`;
  } else if (preview.expired) {
    action = `<p>This invite has expired. Ask an owner of ${org} to send a new one.</p>`;
  } else {
    switch (visitor.kind) {
      case "anonymous":
        action =
          `<p>Sign in with <strong>${invited}</strong> first, then open this link again.</p>` +
          `<div class="auth-actions"><a class="btn-primary" href="/sign-in">Sign in</a><a class="btn" href="/sign-up">Create account</a></div>`;
        break;
      case "pending":
        action = `<p>Finish signing in first, then open this link again.</p><p><a class="btn-primary" href="${escapeAttr(visitor.next)}">Continue sign-in</a></p>`;
        break;
      case "ready":
        if (visitor.email.toLowerCase() !== preview.email.toLowerCase()) {
          action =
            `<p>You are signed in as <strong>${escapeHtml(visitor.email)}</strong>, but this invite is for <strong>${invited}</strong>.</p>` +
            `<p><button type="button" id="accept-signout" class="btn-ghost">Sign out and switch account</button></p>`;
        } else {
          action =
            `<form id="accept-form" data-testid="accept-form"><input type="hidden" name="token" value="${escapeAttr(token)}" />` +
            `<button type="submit" class="btn-primary">Join ${org}</button></form>`;
        }
        break;
      default: {
        const exhaustive: never = visitor;
        throw new Error(`Unhandled visitor: ${String(exhaustive)}`);
      }
    }
  }
  const page = authDocument({
    title: "Join a workspace",
    testid: "accept-invite",
    script: "",
    body: `${lede}${action}`,
  });
  return page.replace("</body>", `<script nonce="${escapeAttr(nonce)}">${ACCEPT_JS}</script>\n</body>`);
}
