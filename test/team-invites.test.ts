/**
 * Team (3.7): invites end to end, roles, removal rules, the accept page, and the session org
 * switcher. Uses the header-based test resolver for the org routes and the identity harness
 * for the cookie-backed switcher route.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { inviteEmail } from "../src/hosted/email.ts";
import { testAuthResolver } from "../src/hosted/auth.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { INVITE_TTL_MS } from "../src/hosted/kernel-members.ts";
import { hashToken } from "../src/hosted/operator-identity.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";
import { api, identityServer, signUpAndEnroll } from "./identity-harness.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

async function setup(limits?: { credentials: number; agents: number; members: number; calls: number; orgs: number }) {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "team.sqlite"));
  const emails: { to: string; subject: string; html: string }[] = [];
  const clock = { now: Date.parse("2026-09-04T09:00:00Z") };
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    sendEmail: async (to, subject, html) => {
      emails.push({ to, subject, html });
    },
    publicUrl: "http://127.0.0.1:8788",
    now: () => new Date(clock.now),
    planLimits: limits,
  });
  const { orgId } = await kernel.createOrg("acme <script>", "user_owner");
  await kernel.addMember(orgId, "user_op", "operator");
  const personal = await kernel.createOrg("personal", "user_new");
  await kernel.createOrg("elsewhere", "user_other");
  for (const [id, email] of [
    ["user_owner", "owner@example.com"],
    ["user_op", "op@example.com"],
    ["user_new", "new@example.com"],
    ["user_other", "other@example.com"],
  ] as const) {
    await store.insertUser({
      id,
      email,
      emailVerifiedAt: "2026-01-01T00:00:00.000Z",
      totpWrappedIv: null,
      totpWrappedCiphertext: null,
      totpWrappedTag: null,
      totpLastStep: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }
  const http = createHostedServer({ kernel, host: "127.0.0.1", port: 0, authResolver: testAuthResolver });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const headers = (user: string, org = orgId) => ({
    "x-test-channel": "operator",
    "x-test-user": user,
    "x-test-org": org,
    "content-type": "application/json",
  });
  return {
    home,
    store,
    kernel,
    emails,
    orgId,
    personalOrgId: personal.orgId,
    clock,
    base,
    headers,
    async close() {
      await http.close();
      await store.close();
      cleanup(home);
    },
  };
}

type Team = {
  members: { user_id: string; email: string; role: string; joined_at: string | null }[];
  invites: { id: string; email: string; role: string; expired: boolean }[];
  role: string;
  user_id: string;
};

async function team(base: string, headers: Record<string, string>): Promise<Team> {
  const res = await fetch(`${base}/api/members`, { headers });
  assert.equal(res.status, 200);
  return (await res.json()) as Team;
}

async function invite(base: string, headers: Record<string, string>, email: string, role = "operator"): Promise<Response> {
  return fetch(`${base}/api/members/invite`, { method: "POST", headers, body: JSON.stringify({ email, role }) });
}

test("members list, owner-only invite, email is escaped, pending invites listed", async () => {
  const ctx = await setup();
  try {
    const owner = ctx.headers("user_owner");
    const snap = await team(ctx.base, owner);
    assert.equal(snap.role, "owner");
    assert.equal(snap.user_id, "user_owner");
    assert.deepEqual(
      snap.members.map((m) => [m.user_id, m.email, m.role]).sort(),
      [
        ["user_op", "op@example.com", "operator"],
        ["user_owner", "owner@example.com", "owner"],
      ],
    );
    assert.ok(snap.members.every((m) => typeof m.joined_at === "string"), "join time recorded");
    assert.deepEqual(snap.invites, []);

    const asOperator = await invite(ctx.base, ctx.headers("user_op"), "new@example.com");
    assert.equal(asOperator.status, 403);

    const res = await invite(ctx.base, owner, "New@Example.com");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { invite: { id: string; email: string; role: string }; accept_url: string; email_sent: boolean };
    assert.equal(body.invite.email, "new@example.com");
    assert.equal(body.invite.role, "operator");
    assert.equal(body.email_sent, true);
    assert.match(body.accept_url, /^http:\/\/127\.0\.0\.1:8788\/accept-invite\?token=[A-Za-z0-9_-]{40,}$/);
    assert.equal(ctx.emails.length, 1);
    assert.equal(ctx.emails[0]?.to, "new@example.com");
    assert.match(ctx.emails[0]?.html ?? "", /acme &lt;script&gt;/, "org name escaped in the email");
    assert.doesNotMatch(ctx.emails[0]?.html ?? "", /<script>/);
    assert.ok(ctx.emails[0]?.html.includes(body.accept_url.replace(/&/g, "&amp;")));
    assert.match(ctx.emails[0]?.html ?? "", /owner@example.com invited you/);

    const after = await team(ctx.base, owner);
    assert.deepEqual(after.invites.map((i) => [i.email, i.role, i.expired]), [["new@example.com", "operator", false]]);
    const audit = await ctx.store.listAudit(ctx.orgId, 50, { action: "member_invited" });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.actor, "user_owner");

    const dup = await invite(ctx.base, owner, "new@example.com");
    assert.equal(dup.status, 409);
    const member = await invite(ctx.base, owner, "op@example.com");
    assert.equal(member.status, 409);
    const bad = await invite(ctx.base, owner, "not-an-email");
    assert.equal(bad.status, 400);
    const badRole = await invite(ctx.base, owner, "x@example.com", "admin");
    assert.equal(badRole.status, 400);
    assert.ok(!JSON.stringify(ctx.emails).includes(CANARY));
  } finally {
    await ctx.close();
  }
});

test("invite email template escapes every field", () => {
  const mail = inviteEmail({ orgName: "<b>x</b>", inviterEmail: "a@b.c\"", role: "owner", acceptUrl: "https://botpasses.com/accept-invite?token=a&b" });
  assert.match(mail.html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(mail.html, /<b>/);
  assert.match(mail.html, /href="https:\/\/botpasses\.com\/accept-invite\?token=a&amp;b"/);
  assert.match(mail.text, /token=a&b/);
  assert.equal(mail.subject, "You are invited to <b>x</b> on Botpasses");
});

test("accept: page states, email mismatch 403, matching email joins, reuse 410, expiry 410", async () => {
  const ctx = await setup({ credentials: 25, agents: 10, members: 10, calls: 5000, orgs: 10 });
  try {
    const owner = ctx.headers("user_owner");
    const res = await invite(ctx.base, owner, "new@example.com", "owner");
    const { accept_url } = (await res.json()) as { accept_url: string };
    const token = new URL(accept_url).searchParams.get("token") ?? "";
    const pagePath = `/accept-invite?token=${encodeURIComponent(token)}`;

    const anon = await fetch(`${ctx.base}${pagePath}`);
    assert.equal(anon.status, 200);
    const anonHtml = await anon.text();
    assert.match(anonHtml, /data-testid="accept-invite"/);
    assert.match(anonHtml, /acme &lt;script&gt;/);
    assert.doesNotMatch(anonHtml, /<script>/);
    assert.match(anonHtml, /href="\/sign-in"/);
    assert.doesNotMatch(anonHtml, /data-testid="accept-form"/, "no accept button before sign-in");
    assert.match(anonHtml, /<script nonce="[^"]+">/);

    const otherOrg = (await ctx.store.listMembershipsForUser("user_other"))[0]?.orgId ?? "";
    const mismatchPage = await fetch(`${ctx.base}${pagePath}`, { headers: ctx.headers("user_other", otherOrg) });
    assert.equal(mismatchPage.status, 200);
    assert.match(await mismatchPage.text(), /signed in as <strong>other@example.com<\/strong>, but this invite is for <strong>new@example.com/);

    const matchPage = await fetch(`${ctx.base}${pagePath}`, { headers: ctx.headers("user_new", ctx.personalOrgId) });
    assert.match(await matchPage.text(), /data-testid="accept-form"/);

    const missing = await fetch(`${ctx.base}/accept-invite?token=nope`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /not valid/);

    const mismatch = await fetch(`${ctx.base}/api/invites/accept`, {
      method: "POST",
      headers: ctx.headers("user_other", otherOrg),
      body: JSON.stringify({ token }),
    });
    assert.equal(mismatch.status, 403);
    assert.deepEqual(await mismatch.json(), { error: "invite_email_mismatch" });
    assert.equal(await ctx.store.getMember(ctx.orgId, "user_other"), undefined);

    const joined = await fetch(`${ctx.base}/api/invites/accept`, {
      method: "POST",
      headers: ctx.headers("user_new", ctx.personalOrgId),
      body: JSON.stringify({ token }),
    });
    assert.equal(joined.status, 200);
    assert.deepEqual(await joined.json(), { org_id: ctx.orgId, org_name: "acme <script>", role: "owner" });
    const member = await ctx.store.getMember(ctx.orgId, "user_new");
    assert.equal(member?.role, "owner");
    const snap = await team(ctx.base, owner);
    assert.deepEqual(snap.invites, []);
    assert.ok(snap.members.some((m) => m.user_id === "user_new" && m.role === "owner" && m.email === "new@example.com"));
    const audit = await ctx.store.listAudit(ctx.orgId, 50, { action: "member_joined" });
    assert.equal(audit[0]?.actor, "user_new");

    const reuse = await fetch(`${ctx.base}/api/invites/accept`, {
      method: "POST",
      headers: ctx.headers("user_new", ctx.personalOrgId),
      body: JSON.stringify({ token }),
    });
    assert.equal(reuse.status, 410);
    const usedPage = await fetch(`${ctx.base}${pagePath}`);
    assert.match(await usedPage.text(), /already used/);

    // Expiry: a second invite, then eight days pass.
    const second = await invite(ctx.base, owner, "other@example.com");
    const secondUrl = ((await second.json()) as { accept_url: string }).accept_url;
    const secondToken = new URL(secondUrl).searchParams.get("token") ?? "";
    ctx.clock.now += INVITE_TTL_MS + DAY_MS;
    const expiredList = await team(ctx.base, owner);
    assert.deepEqual(expiredList.invites.map((i) => [i.email, i.expired]), [["other@example.com", true]]);
    const expired = await fetch(`${ctx.base}/api/invites/accept`, {
      method: "POST",
      headers: ctx.headers("user_other", otherOrg),
      body: JSON.stringify({ token: secondToken }),
    });
    assert.equal(expired.status, 410);
    assert.match(await (await fetch(`${ctx.base}/accept-invite?token=${encodeURIComponent(secondToken)}`)).text(), /expired/);
    assert.equal(await ctx.store.getMember(ctx.orgId, "user_other"), undefined);
  } finally {
    await ctx.close();
  }
});

test("roles and removal: owner-only, the last owner cannot be demoted or removed, cancel invite", async () => {
  const ctx = await setup();
  try {
    const owner = ctx.headers("user_owner");
    const opHeaders = ctx.headers("user_op");
    const role = (actor: Record<string, string>, userId: string, next: string) =>
      fetch(`${ctx.base}/api/members/${userId}/role`, { method: "POST", headers: actor, body: JSON.stringify({ role: next }) });
    const remove = (actor: Record<string, string>, userId: string) =>
      fetch(`${ctx.base}/api/members/${userId}`, { method: "DELETE", headers: actor });

    assert.equal((await role(opHeaders, "user_owner", "operator")).status, 403);
    assert.equal((await remove(opHeaders, "user_owner")).status, 403);

    assert.equal((await role(owner, "user_owner", "operator")).status, 400, "sole owner cannot demote themself");
    assert.equal((await remove(owner, "user_owner")).status, 400, "sole owner cannot remove themself");
    assert.equal((await remove(owner, "user_ghost")).status, 404);
    assert.equal((await role(owner, "user_op", "admin")).status, 400);

    const promoted = await role(owner, "user_op", "owner");
    assert.equal(promoted.status, 200);
    assert.deepEqual(((await promoted.json()) as { member: { role: string } }).member.role, "owner");
    assert.equal((await ctx.store.listAudit(ctx.orgId, 50, { action: "member_role" })).length, 1);

    assert.equal((await role(owner, "user_owner", "operator")).status, 200, "two owners: one may step down");
    assert.equal((await role(opHeaders, "user_op", "operator")).status, 400, "now user_op is the last owner");
    assert.equal((await remove(opHeaders, "user_op")).status, 400, "last owner cannot remove themself");

    const removed = await remove(opHeaders, "user_owner");
    assert.equal(removed.status, 200);
    assert.equal(await ctx.store.getMember(ctx.orgId, "user_owner"), undefined);
    assert.equal((await ctx.store.listAudit(ctx.orgId, 50, { action: "member_removed" })).length, 1);
    const gone = await fetch(`${ctx.base}/api/members`, { headers: owner });
    assert.equal(gone.status, 403, "removed member has no access");

    const sent = await invite(ctx.base, opHeaders, "new@example.com");
    const { invite: inv } = (await sent.json()) as { invite: { id: string } };
    assert.equal((await fetch(`${ctx.base}/api/invites/${inv.id}`, { method: "DELETE", headers: ctx.headers("user_new", ctx.personalOrgId) })).status, 404, "another org cannot cancel it");
    assert.equal((await fetch(`${ctx.base}/api/invites/${inv.id}`, { method: "DELETE", headers: opHeaders })).status, 200);
    assert.deepEqual((await team(ctx.base, opHeaders)).invites, []);
    assert.equal((await fetch(`${ctx.base}/api/invites/${inv.id}`, { method: "DELETE", headers: opHeaders })).status, 404);
  } finally {
    await ctx.close();
  }
});

test("members plan limit counts seats and pending invites", async () => {
  const ctx = await setup({ credentials: 25, agents: 10, members: 3, calls: 5000, orgs: 10 });
  try {
    const owner = ctx.headers("user_owner");
    assert.equal((await invite(ctx.base, owner, "new@example.com")).status, 200, "third seat");
    const over = await invite(ctx.base, owner, "other@example.com");
    assert.equal(over.status, 402);
    assert.deepEqual(await over.json(), { error: "plan_limit", kind: "members", limit: 3 });
  } finally {
    await ctx.close();
  }
});

test("org switcher: store pins the session org, kernel prefers it while membership lasts", async () => {
  const ctx = await setup();
  try {
    const { store, kernel } = ctx;
    await store.insertSession({
      idHash: "sess_a",
      userId: "user_new",
      createdAt: "2026-09-04T00:00:00.000Z",
      lastSeenAt: "2026-09-04T00:00:00.000Z",
      expiresAt: "2026-09-05T00:00:00.000Z",
      mfaAt: "2026-09-04T00:00:00.000Z",
    });
    assert.equal((await store.getSession("sess_a"))?.activeOrgId, null);
    // Memberships list oldest first by `joined_at`; join the second org later than the personal one.
    ctx.clock.now += 60_000;
    await kernel.addMember(ctx.orgId, "user_new", "operator");
    await store.setSessionActiveOrg("sess_a", ctx.orgId);
    assert.equal((await store.getSession("sess_a"))?.activeOrgId, ctx.orgId);

    assert.deepEqual(await kernel.ensureVaultOrgForUser("user_new"), { orgId: ctx.personalOrgId, role: "owner" });
    assert.deepEqual(await kernel.ensureVaultOrgForUser("user_new", ctx.orgId), { orgId: ctx.orgId, role: "operator" });
    assert.deepEqual(await kernel.ensureVaultOrgForUser("user_new", "org_unknown"), { orgId: ctx.personalOrgId, role: "owner" });

    const orgs = await kernel.listOrgsForUser("user_new", ctx.orgId);
    assert.deepEqual(
      orgs.map((o) => [o.org_id, o.name, o.role, o.active]),
      [
        [ctx.personalOrgId, "personal", "owner", false],
        [ctx.orgId, "acme <script>", "operator", true],
      ],
    );
    await assert.rejects(kernel.setActiveOrg({ userId: "user_other", sessionHash: "sess_a", orgId: ctx.orgId }), /Not a member/);

    await kernel.removeMember({ orgId: ctx.orgId, actorUserId: "user_owner", actorRole: "owner", userId: "user_new" });
    assert.equal((await store.getSession("sess_a"))?.activeOrgId, null, "removal clears the pinned org");
    assert.deepEqual(await kernel.ensureVaultOrgForUser("user_new", ctx.orgId), { orgId: ctx.personalOrgId, role: "owner" });
  } finally {
    await ctx.close();
  }
});

test("POST /api/session/org pins a member org on the cookie session and rejects foreign orgs", async () => {
  const ctx = await identityServer();
  try {
    const { jar } = await signUpAndEnroll(ctx, "switch@example.com");
    const me = await api(ctx, "/api/orgs", { jar });
    assert.equal(me.status, 200);
    const first = (await me.json()) as { orgs: { org_id: string; active: boolean }[] };
    assert.equal(first.orgs.length, 1);
    assert.equal(first.orgs[0]?.active, true);
    const user = await ctx.store.getUserByEmail("switch@example.com");
    assert.ok(user);
    const second = await ctx.kernel.createOrg("second", user.id);
    const foreign = await ctx.kernel.createOrg("foreign", "user_someone_else");

    const denied = await api(ctx, "/api/session/org", { jar, csrf: true, body: { org_id: foreign.orgId } });
    assert.equal(denied.status, 403);
    const noCsrf = await api(ctx, "/api/session/org", { jar, body: { org_id: second.orgId } });
    assert.equal(noCsrf.status, 403);
    const ok = await api(ctx, "/api/session/org", { jar, csrf: true, body: { org_id: second.orgId } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { org: { org_id: second.orgId, name: "second", role: "owner", active: true } });
    const session = await ctx.store.getSession(hashToken(jar.token));
    assert.equal(session?.activeOrgId, second.orgId);
    const orgs = await api(ctx, "/api/orgs", { jar });
    assert.equal(((await orgs.json()) as { orgs: unknown[] }).orgs.length, 2);
  } finally {
    await ctx.close();
  }
});
