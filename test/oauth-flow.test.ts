import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { decodeJwt } from "jose";
import { endOidcSession } from "../src/hosted/oauth-as.ts";
import { CANARY } from "./helpers.ts";
import { AUDIENCE, ISSUER, Jar, itemNames, pkce, startOauthServer } from "./oauth-helpers.ts";

const REDIRECT = "http://127.0.0.1:9999/cb";

test("S10/1.4 secure-cookie authorize, consent, code, JWT, MCP, refresh rotation and reuse detection", async () => {
  const srv = await startOauthServer({ secure: true, deployPlane: "staging" });
  try {
    const a = await srv.signInReady("alice@example.com");
    await srv.kernel.createItem({
      orgId: a.orgId,
      actor: a.userId,
      environment: "staging",
      kind: "secret",
      name: "ALICE_KEY",
      value: CANARY,
      allowedHosts: ["api.example.com"],
      inject: "bearer",
    });
    const client = await srv.registerClient({ client_name: "Claude Desktop", redirect_uris: [REDIRECT] });
    const { verifier, challenge } = pkce();

    const first = await srv.authorizeWithConsent({ jar: a.jar, clientId: client.client_id, redirectUri: REDIRECT, challenge });
    assert.match(first.consentHtml, /data-testid="consent-client">Claude Desktop</);
    assert.match(first.consentHtml, /data-testid="consent-hosts"[\s\S]*127\.0\.0\.1:9999/);
    assert.match(first.consentHtml, /data-testid="consent-first-time"/);
    assert.match(first.consentHtml, /data-testid="consent-account">Approving as <strong>alice@example\.com</);
    assert.doesNotMatch(first.consentHtml, new RegExp(client.client_id));
    assert.equal(first.location.origin + first.location.pathname, REDIRECT);
    assert.equal(first.location.searchParams.get("state"), "st");
    assert.equal(first.location.searchParams.get("iss"), ISSUER);

    const issued = await srv.token({
      grant_type: "authorization_code",
      code: first.code,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: AUDIENCE,
    });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const access1 = String(issued.body.access_token);
    const refresh1 = String(issued.body.refresh_token);
    assert.match(access1, /^eyJ/);
    assert.ok(refresh1);
    const claims = decodeJwt(access1);
    assert.equal(claims.sub, a.userId);
    assert.equal(claims.client_id, client.client_id);
    assert.equal(claims.aud, AUDIENCE);

    const listed = await srv.mcp(access1, "tools/call", { name: "list_items", arguments: {} });
    assert.equal(listed.status, 200);
    assert.deepEqual(itemNames(await listed.json()), ["ALICE_KEY"]);

    const vaultClient = (await srv.store.listClients(a.orgId)).find((c) => c.oauthClientId === client.client_id);
    assert.ok(vaultClient, "vault client created at first issue");
    assert.equal(vaultClient.environment, "staging");
    assert.equal(vaultClient.name, "Claude Desktop");
    assert.equal(vaultClient.consentedByUserId, a.userId);

    // Rotation: the refresh token is single use, the replacement works once.
    const rotated = await srv.token({ grant_type: "refresh_token", refresh_token: refresh1, client_id: client.client_id });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    const refresh2 = String(rotated.body.refresh_token);
    assert.notEqual(refresh2, refresh1);
    const access2 = String(rotated.body.access_token);
    assert.equal((await srv.mcp(access2, "tools/list")).status, 200);

    // Reuse detection: replaying refresh1 fails and burns the whole grant, so refresh2 dies too.
    const replay = await srv.token({ grant_type: "refresh_token", refresh_token: refresh1, client_id: client.client_id });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");
    const afterReplay = await srv.token({ grant_type: "refresh_token", refresh_token: refresh2, client_id: client.client_id });
    assert.equal(afterReplay.status, 400);
    assert.equal(afterReplay.body.error, "invalid_grant");

    // Second authorize inside the OP session: consent is prompted again (native client),
    // the interaction resolves the stored session by uid, and the client is no longer new.
    assert.ok(a.jar.get("_session"), "OP session cookie set after login");
    const again = await srv.authorizeWithConsent({ jar: a.jar, clientId: client.client_id, redirectUri: REDIRECT, challenge: pkce().challenge, state: "two" });
    assert.doesNotMatch(again.consentHtml, /consent-first-time/);
    assert.match(again.consentHtml, /consent-client">Claude Desktop</);

    const events = await srv.store.listAccessEvents(a.orgId, 50);
    assert.ok(events.some((e) => e.kind === "oauth_access"));
    assert.ok(events.some((e) => e.kind === "oauth_refresh"));
    assert.ok(!JSON.stringify(events).includes("eyJ"));
  } finally {
    await srv.close();
  }
});

test("S2/0.2 two operators share one DCR client id: each JWT sees its own org, revoke in A keeps B's refresh alive", async () => {
  const srv = await startOauthServer({ secure: true, deployPlane: "staging" });
  try {
    const client = await srv.registerClient({ client_name: "Cursor", redirect_uris: [REDIRECT] });
    const users = [] as { userId: string; orgId: string; access: string; refresh: string }[];
    for (const [email, itemName] of [
      ["a@example.com", "A_KEY"],
      ["b@example.com", "B_KEY"],
    ] as const) {
      const who = await srv.signInReady(email);
      await srv.kernel.createItem({
        orgId: who.orgId,
        actor: who.userId,
        environment: "staging",
        kind: "secret",
        name: itemName,
        value: CANARY,
        allowedHosts: ["api.example.com"],
        inject: "bearer",
      });
      const { verifier, challenge } = pkce();
      const leg = await srv.authorizeWithConsent({ jar: who.jar, clientId: client.client_id, redirectUri: REDIRECT, challenge });
      const issued = await srv.token({
        grant_type: "authorization_code",
        code: leg.code,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: AUDIENCE,
      });
      assert.equal(issued.status, 200, JSON.stringify(issued.body));
      users.push({ ...who, access: String(issued.body.access_token), refresh: String(issued.body.refresh_token) });
    }
    const [a, b] = users;
    assert.ok(a && b);
    assert.notEqual(a.orgId, b.orgId);

    assert.deepEqual(itemNames(await (await srv.mcp(a.access, "tools/call", { name: "list_items", arguments: {} })).json()), ["A_KEY"]);
    assert.deepEqual(itemNames(await (await srv.mcp(b.access, "tools/call", { name: "list_items", arguments: {} })).json()), ["B_KEY"]);

    const clientA = (await srv.store.listClients(a.orgId)).find((c) => c.oauthClientId === client.client_id);
    const clientB = (await srv.store.listClients(b.orgId)).find((c) => c.oauthClientId === client.client_id);
    assert.ok(clientA && clientB);
    assert.notEqual(clientA.id, clientB.id);
    assert.equal(clientA.consentedByUserId, a.userId);
    assert.equal(clientB.consentedByUserId, b.userId);

    await srv.kernel.revokeClient(a.orgId, a.userId, clientA.id);

    assert.equal((await srv.mcp(a.access, "tools/list")).status, 401);
    const aRefresh = await srv.token({ grant_type: "refresh_token", refresh_token: a.refresh, client_id: client.client_id });
    assert.equal(aRefresh.status, 400);

    assert.equal((await srv.mcp(b.access, "tools/list")).status, 200);
    const bRefresh = await srv.token({ grant_type: "refresh_token", refresh_token: b.refresh, client_id: client.client_id });
    assert.equal(bRefresh.status, 200, JSON.stringify(bRefresh.body));
    const bListed = await srv.mcp(String(bRefresh.body.access_token), "tools/call", { name: "list_items", arguments: {} });
    assert.deepEqual(itemNames(await bListed.json()), ["B_KEY"]);
  } finally {
    await srv.close();
  }
});

test("S5/S12 device flow: xsrf field renders, confirm page names the client, consent completes, token polls", async () => {
  const srv = await startOauthServer({ secure: true, deployPlane: "staging" });
  try {
    const op = await srv.signInReady("dev@example.com");
    const client = await srv.registerClient({ client_name: "Grok CLI", redirect_uris: ["grok://oauth/callback"] });
    const started = await srv.go("/oauth/device/auth", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, scope: "openid mcp", resource: AUDIENCE }),
    });
    const device = (await started.json()) as { device_code: string; user_code: string; verification_uri: string };
    assert.equal(started.status, 200, JSON.stringify(device));
    assert.equal(new URL(device.verification_uri).pathname, "/device");

    const page = await srv.go("/device", { jar: op.jar });
    const pageHtml = await page.text();
    assert.equal(page.status, 200, pageHtml);
    assert.match(pageHtml, /data-testid="device-code"/);
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(pageHtml)?.[1];
    assert.ok(xsrf, "hidden xsrf field must be rendered");
    assert.doesNotMatch(pageHtml, /fonts\.googleapis/);

    const entered = await srv.go("/device", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ xsrf, user_code: device.user_code }),
      jar: op.jar,
    });
    const confirmHtml = await entered.text();
    assert.equal(entered.status, 200, confirmHtml);
    assert.match(confirmHtml, /data-testid="device-confirm"/);
    assert.match(confirmHtml, /data-testid="device-client">Grok CLI</);
    assert.match(confirmHtml, /name="user_code"/);
    const confirmXsrf = /name="xsrf" value="([^"]+)"/.exec(confirmHtml)?.[1];
    assert.ok(confirmXsrf);

    const confirmed = await srv.go("/device", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ xsrf: confirmXsrf, user_code: device.user_code, confirm: "yes" }),
      jar: op.jar,
    });
    assert.equal(confirmed.status, 303, await confirmed.text());
    const consentPath = confirmed.headers.get("location") ?? "";
    assert.match(consentPath, /^\/consent\?uid=/);
    const uid = new URL(consentPath, srv.base).searchParams.get("uid") ?? "";
    const consent = await srv.go(consentPath, { jar: op.jar });
    const consentHtml = await consent.text();
    assert.equal(consent.status, 200, consentHtml);
    assert.match(consentHtml, /consent-client">Grok CLI</);
    assert.match(consentHtml, /consent-hosts"[\s\S]*grok:\/\//);
    const decided = await srv.go("/consent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": op.jar.csrf() },
      body: JSON.stringify({ uid, decision: "allow" }),
      jar: op.jar,
    });
    assert.equal(decided.status, 303, await decided.text());
    const resume = new URL(decided.headers.get("location") ?? "", srv.base);
    assert.match(resume.pathname, /^\/device\//);
    const done = await srv.go(resume.pathname, { jar: op.jar });
    const doneHtml = await done.text();
    assert.equal(done.status, 200, doneHtml);
    assert.match(doneHtml, /data-testid="device-success"/);
    assert.match(doneHtml, /Grok CLI/);

    const issued = await srv.token({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: client.client_id,
    });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal((await srv.mcp(String(issued.body.access_token), "tools/list")).status, 200);

    // A wrong code re-renders the input page with the xsrf field, not a 400 xsrf error.
    const fresh = new Jar();
    const again = await srv.go("/device", { jar: fresh });
    const againXsrf = /name="xsrf" value="([^"]+)"/.exec(await again.text())?.[1];
    assert.ok(againXsrf);
    const wrong = await srv.go("/device", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ xsrf: againXsrf, user_code: "000000000" }),
      jar: fresh,
    });
    const wrongHtml = await wrong.text();
    assert.match(wrongHtml, /did not work/);
    assert.match(wrongHtml, /name="xsrf" value="/);
  } finally {
    await srv.close();
  }
});

test("S12 consent decision must be the literal allow; deny and garbage are access_denied", async () => {
  const srv = await startOauthServer({ secure: true, deployPlane: "staging" });
  try {
    const op = await srv.signInReady("deny@example.com");
    const client = await srv.registerClient({ client_name: "Denier", redirect_uris: [REDIRECT] });
    for (const decision of ["deny", "ALLOW", "allow ", 1, true, undefined]) {
      const params = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        response_type: "code",
        scope: "openid mcp",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        resource: AUDIENCE,
        state: "d",
      });
      const authorize = await srv.go(`/oauth/authorize?${params}`, { jar: op.jar });
      assert.equal(authorize.status, 303);
      const uid = new URL(authorize.headers.get("location") ?? "", srv.base).searchParams.get("uid") ?? "";
      const decided = await srv.go("/consent", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": op.jar.csrf() },
        body: JSON.stringify(decision === undefined ? { uid } : { uid, decision }),
        jar: op.jar,
      });
      assert.equal(decided.status, 303, `decision=${String(decision)}`);
      const resumed = await srv.go(new URL(decided.headers.get("location") ?? "", srv.base).pathname, { jar: op.jar });
      assert.equal(resumed.status, 303);
      const back = new URL(resumed.headers.get("location") ?? "");
      assert.equal(back.searchParams.get("error"), "access_denied", `decision=${String(decision)}`);
      assert.equal(back.searchParams.get("code"), null);
    }
    // A consent form whose uid does not match the pending interaction is refused.
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "openid mcp",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: AUDIENCE,
    });
    await srv.go(`/oauth/authorize?${params}`, { jar: op.jar });
    const mismatch = await srv.go("/consent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": op.jar.csrf() },
      body: JSON.stringify({ uid: "someone-elses", decision: "allow" }),
      jar: op.jar,
    });
    assert.equal(mismatch.status, 400);
    // No pending interaction at all renders the expired page, not a consent form.
    const stale = await srv.go("/consent?uid=nope", {
      headers: { cookie: op.jar.header((name) => name.startsWith("__Host-bp_")) },
    });
    assert.equal(stale.status, 400);
    assert.match(await stale.text(), /data-testid="oauth-consent-expired"/);
  } finally {
    await srv.close();
  }
});

test("S12 endOidcSession destroys the OP session so the next authorize needs a fresh login", async () => {
  const srv = await startOauthServer({ secure: true, deployPlane: "staging" });
  try {
    const op = await srv.signInReady("out@example.com");
    const client = await srv.registerClient({ client_name: "Logout", redirect_uris: [REDIRECT] });
    await srv.authorizeWithConsent({ jar: op.jar, clientId: client.client_id, redirectUri: REDIRECT, challenge: pkce().challenge });
    const sessionCookie = op.jar.get("_session");
    assert.ok(sessionCookie);
    const before = await srv.store.listOidcPayloads("Session");
    assert.equal(before.length, 1);

    // Stand-in for POST /api/auth/logout (owned by another unit): it must call endOidcSession.
    const relay = createServer((req, res) => {
      void endOidcSession(srv.oidcProvider, req, res)
        .then((cookies) => {
          res.writeHead(200, { "set-cookie": cookies });
          res.end();
        })
        .catch((err: unknown) => {
          res.writeHead(500);
          res.end(err instanceof Error ? err.message : String(err));
        });
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const addr = relay.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/logout`, {
        method: "POST",
        headers: { cookie: op.jar.header(), "x-forwarded-proto": "https" },
      });
      assert.equal(res.status, 200, await res.text());
      const cleared = res.headers.getSetCookie();
      assert.ok(cleared.some((c) => c.startsWith("_session=;") && /Secure/.test(c)));
      assert.ok(cleared.some((c) => c.startsWith("_session.sig=;")));
    } finally {
      await new Promise<void>((resolve, reject) => relay.close((err) => (err ? reject(err) : resolve())));
    }
    assert.deepEqual(await srv.store.listOidcPayloads("Session"), []);

    // The stale cookie no longer carries a login: authorize prompts again for login (session gone).
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "openid mcp",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: AUDIENCE,
    });
    const authorize = await srv.go(`/oauth/authorize?${params}`, { jar: op.jar });
    assert.equal(authorize.status, 303);
    const details = await srv.store.listOidcPayloads("Interaction");
    const latest = details.map((d) => JSON.parse(d.payload) as { prompt?: { name?: string }; session?: unknown }).at(-1);
    assert.equal(latest?.prompt?.name, "login");
  } finally {
    await srv.close();
  }
});
