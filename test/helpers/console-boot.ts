/**
 * Boots the hosted server on sqlite with first-party identity and a captured mailbox,
 * for browser smoke tests and screenshot scripts. Loopback only, random port.
 */
import { join } from "node:path";
import { generateMasterKey, parseMasterKey } from "../../src/crypto.ts";
import { createHostedServer } from "../../src/hosted/http.ts";
import { identityAuthResolver } from "../../src/hosted/identity.ts";
import { HostedKernel } from "../../src/hosted/kernel.ts";
import { OperatorIdentity } from "../../src/hosted/operator-identity.ts";
import { openHostedSqlite } from "../../src/store/sqlite-hosted.ts";
import { TEST_SESSION_SECRET, cleanup, tempHome } from "../helpers.ts";

export type CapturedMail = { to: string; subject: string; html: string; text: string };

export type ConsoleServer = {
  base: string;
  mailbox: CapturedMail[];
  /** Newest 8-digit code sent to `email`. */
  otpFor: (email: string) => string;
  close: () => Promise<void>;
};

export async function bootConsoleServer(
  opts: { deployPlane?: "staging" | "production"; siteRoot?: string } = {},
): Promise<ConsoleServer> {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "console-smoke.sqlite"));
  const kek = parseMasterKey(generateMasterKey());
  const mailbox: CapturedMail[] = [];
  const sendEmail = async (to: string, subject: string, html: string, text?: string): Promise<void> => {
    mailbox.push({ to, subject, html, text: text ?? "" });
  };
  const publicUrl = "http://127.0.0.1:8788";
  const deployPlane = opts.deployPlane ?? "production";
  const kernel = new HostedKernel({ store, kek, publicUrl, deployPlane, sendEmail });
  const identity = new OperatorIdentity({ store, sessionSecret: TEST_SESSION_SECRET, kek, sendEmail });
  const authResolver = identityAuthResolver({ identity, kernel, secureCookies: false });
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    publicUrl,
    authResolver,
    identity,
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
