/**
 * Boots the hosted server on sqlite with first-party identity and a captured mailbox,
 * for browser smoke tests and screenshot scripts. Loopback only, random port.
 *
 * With `oauth: true` the OAuth authorization server is mounted as well. Its issuer must be
 * the origin the browser is on (resume URLs are absolute), so the port is chosen up front.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type Provider from "oidc-provider";
import { generateMasterKey, parseMasterKey } from "../../src/crypto.ts";
import { parseOidcPrivateJwk } from "../../src/hosted/boot.ts";
import { createHostedServer } from "../../src/hosted/http.ts";
import { identityAuthResolver } from "../../src/hosted/identity.ts";
import { HostedKernel } from "../../src/hosted/kernel.ts";
import { createOauthProvider } from "../../src/hosted/oauth-as.ts";
import { OperatorIdentity } from "../../src/hosted/operator-identity.ts";
import { openHostedSqlite } from "../../src/store/sqlite-hosted.ts";
import { TEST_SESSION_SECRET, cleanup, tempHome, testOidcPrivateJwk } from "../helpers.ts";

export type CapturedMail = { to: string; subject: string; html: string; text: string };

export type ConsoleServer = {
  base: string;
  mailbox: CapturedMail[];
  /** Newest 8-digit code sent to `email`. */
  otpFor: (email: string) => string;
  close: () => Promise<void>;
};

/** A loopback port nothing is listening on right now. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export async function bootConsoleServer(
  opts: { deployPlane?: "staging" | "production"; siteRoot?: string; oauth?: boolean } = {},
): Promise<ConsoleServer> {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "console-smoke.sqlite"));
  const kek = parseMasterKey(generateMasterKey());
  const mailbox: CapturedMail[] = [];
  const sendEmail = async (to: string, subject: string, html: string, text?: string): Promise<void> => {
    mailbox.push({ to, subject, html, text: text ?? "" });
  };
  const port = opts.oauth ? await freeLoopbackPort() : 0;
  const publicUrl = opts.oauth ? `http://127.0.0.1:${port}` : "http://127.0.0.1:8788";
  const deployPlane = opts.deployPlane ?? "production";
  const kernel = new HostedKernel({ store, kek, publicUrl, deployPlane, sendEmail });
  const identity = new OperatorIdentity({ store, sessionSecret: TEST_SESSION_SECRET, kek, sendEmail });
  let oidcProvider: Provider | undefined;
  let oidc: { oidcJwk: NonNullable<ReturnType<typeof parseOidcPrivateJwk>>; issuer: string } | undefined;
  if (opts.oauth) {
    const jwk = parseOidcPrivateJwk(testOidcPrivateJwk());
    if (!jwk) throw new Error("test OIDC JWK did not parse");
    oidcProvider = createOauthProvider({
      issuer: publicUrl,
      kernel,
      sessionSecret: TEST_SESSION_SECRET,
      jwk,
      secureCookies: false,
      deployPlane,
      oidcDirectory: kernel.oidc,
    });
    oidc = { oidcJwk: jwk, issuer: publicUrl };
  }
  const authResolver = identityAuthResolver({ identity, kernel, secureCookies: false, ...oidc });
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port,
    publicUrl,
    authResolver,
    identity,
    oidcProvider,
    secureCookies: false,
    siteRoot: opts.siteRoot,
    deployPlane,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    resolveAddresses: async () => ["8.8.8.8"],
  });
  const addr = await http.listen();
  return {
    base: `http://${addr.host}:${addr.port}`,
    mailbox,
    otpFor: (email) => {
      const mails = mailbox.filter((m) => m.to === email);
      for (let i = mails.length - 1; i >= 0; i--) {
        const m = /(\d{8})/.exec(mails[i]?.text ?? "") ?? />(\d{8})</.exec(mails[i]?.html ?? "");
        if (m?.[1]) return m[1];
      }
      return "";
    },
    close: async () => {
      await http.close();
      await store.close();
      cleanup(home);
    },
  };
}
