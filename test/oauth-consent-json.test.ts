/**
 * The consent page's script cannot read the Location of a 303 (browsers hide redirects from
 * fetch), so a caller that accepts JSON gets `200 { location }` and navigates itself. A caller
 * that sends the CSRF header without `Accept: application/json` keeps the 303 (B1). A form
 * submit without the header (a browser with scripts off) is 403: POST /consent needs the
 * double-submit token like every other cookie-session mutation (R1-3).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_JS } from "../src/hosted/hosted-assets.ts";
import { AUDIENCE, type Jar, pkce, startOauthServer } from "./oauth-helpers.ts";

const REDIRECT = "http://127.0.0.1:9999/cb";

function authorizeParams(clientId: string, challenge: string, state: string): URLSearchParams {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid mcp",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: AUDIENCE,
    state,
  });
}

test("B1 consent POST answers a JSON caller with 200 { location }; the resume URL redirects back with a code", async () => {
  const srv = await startOauthServer({ secure: true, deployPlane: "staging" });
  try {
    const op = await srv.signInReady("browser@example.com");
    const client = await srv.registerClient({ client_name: "Browser App", redirect_uris: [REDIRECT] });

    async function pendingUid(jar: Jar, challenge: string, state: string): Promise<string> {
      const authorize = await srv.go(`/oauth/authorize?${authorizeParams(client.client_id, challenge, state)}`, { jar });
      assert.equal(authorize.status, 303, await authorize.text());
      return new URL(authorize.headers.get("location") ?? "", srv.base).searchParams.get("uid") ?? "";
    }

    // Allow, as the page's script does it.
    const { verifier, challenge } = pkce();
    const uid = await pendingUid(op.jar, challenge, "one");
    const decided = await srv.go("/consent", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": op.jar.csrf() },
      body: JSON.stringify({ uid, decision: "allow" }),
      jar: op.jar,
    });
    const decidedText = await decided.text();
    assert.equal(decided.status, 200, decidedText);
    assert.match(decided.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(decided.headers.get("cache-control"), "no-store");
    assert.equal(decided.headers.get("x-frame-options"), "DENY");
    const body = JSON.parse(decidedText) as { location?: string };
    assert.ok(body.location, "resume URL in the JSON body");
    // oidc-provider builds the resume URL from the request's own host, so only the path is fixed.
    const resume = new URL(body.location, srv.base);
    assert.match(resume.pathname, /^\/oauth\/authorize\/[^/]+$/);
    const resumed = await srv.go(resume.pathname, { jar: op.jar });
    assert.equal(resumed.status, 303, await resumed.text());
    const back = new URL(resumed.headers.get("location") ?? "");
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get("state"), "one");
    const code = back.searchParams.get("code") ?? "";
    assert.ok(code);
    const issued = await srv.token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: AUDIENCE,
    });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.match(String(issued.body.access_token), /^eyJ/);

    // Deny follows the same contract and ends in access_denied.
    const denyUid = await pendingUid(op.jar, pkce().challenge, "two");
    const denied = await srv.go("/consent", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": op.jar.csrf() },
      body: JSON.stringify({ uid: denyUid, decision: "deny" }),
      jar: op.jar,
    });
    const deniedText = await denied.text();
    assert.equal(denied.status, 200, deniedText);
    const denyBody = JSON.parse(deniedText) as { location?: string };
    assert.ok(denyBody.location);
    const denyResumed = await srv.go(new URL(denyBody.location).pathname, { jar: op.jar });
    assert.equal(denyResumed.status, 303);
    assert.equal(new URL(denyResumed.headers.get("location") ?? "").searchParams.get("error"), "access_denied");

    // Without `Accept: application/json` the 303 stays (Node clients).
    const plainUid = await pendingUid(op.jar, pkce().challenge, "three");
    const plain = await srv.go("/consent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": op.jar.csrf() },
      body: JSON.stringify({ uid: plainUid, decision: "allow" }),
      jar: op.jar,
    });
    assert.equal(plain.status, 303, await plain.text());
    assert.match(new URL(plain.headers.get("location") ?? "", srv.base).pathname, /^\/oauth\/authorize\//);

    // A form body with the CSRF header is understood too and gets the 303.
    const formUid = await pendingUid(op.jar, pkce().challenge, "four");
    const form = await srv.go("/consent", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": op.jar.csrf() },
      body: new URLSearchParams({ uid: formUid, decision: "allow" }),
      jar: op.jar,
    });
    assert.equal(form.status, 303, await form.text());
    const formResumed = await srv.go(new URL(form.headers.get("location") ?? "", srv.base).pathname, { jar: op.jar });
    assert.ok(new URL(formResumed.headers.get("location") ?? "").searchParams.get("code"));

    // The consent form carries no CSRF field, so a submit without the header (scripts off)
    // is refused; it never reaches the provider and the pending request stays undecided.
    const bareUid = await pendingUid(op.jar, pkce().challenge, "five");
    const bare = await srv.go("/consent", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: op.jar.header() },
      body: new URLSearchParams({ uid: bareUid, decision: "allow" }),
    });
    assert.equal(bare.status, 403, await bare.text());
    const stillPending = await srv.go("/consent", { jar: op.jar });
    assert.equal(stillPending.status, 200, "the interaction is still open after the refused submit");
  } finally {
    await srv.close();
  }
});

test("B1 the consent script asks for JSON and navigates to the returned location; it no longer reads a redirect header", () => {
  const consent = /const consentForm[\s\S]*$/.exec(AUTH_JS)?.[0] ?? "";
  assert.ok(consent.length > 0);
  assert.match(consent, /accept = "application\/json"/);
  assert.match(consent, /j\.location/);
  assert.doesNotMatch(consent, /redirect: "manual"/);
  assert.doesNotMatch(consent, /headers\.get\("location"\)/);
});
