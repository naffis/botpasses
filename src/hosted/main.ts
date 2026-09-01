import { resolve } from "node:path";
import { hostedDeployPlane, PRODUCT_NAME, resolvePublicOrigin } from "../brand.ts";
import { zeroKey } from "../crypto.ts";
import { HostedKernel } from "./kernel.ts";
import { createHostedServer } from "./http.ts";
import { createResendSender } from "./email.ts";
import { assertHostedBoot, HOSTED_CONFIG_EXIT, parseOidcPrivateJwk } from "./boot.ts";
import { selectKekProvider, usedRawKekFallback } from "./kms.ts";
import { logVaultEvent } from "./observe.ts";
import { PostgresStore } from "../store/postgres.ts";
import { hostedAuthResolver, testAuthResolver } from "./auth.ts";
import { OperatorIdentity } from "./operator-identity.ts";
import { identityAuthResolver } from "./identity.ts";
import { createOauthProvider } from "./oauth-as.ts";

export async function startHosted(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    assertHostedBoot(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(HOSTED_CONFIG_EXIT);
  }
  let kek: Buffer;
  try {
    kek = await selectKekProvider(env).unwrap();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`KMS unwrap failed: ${message}`);
    process.exit(HOSTED_CONFIG_EXIT);
  }
  if (usedRawKekFallback(env)) {
    logVaultEvent("kek_raw_fallback", { plane: env.VAULT_DEPLOY_PLANE ?? "" });
  }
  const store = await PostgresStore.open(env.DATABASE_URL ?? "");
  const sendEmail = env.RESEND_API_KEY
    ? createResendSender(env.RESEND_API_KEY, env.VAULT_EMAIL_FROM ?? "")
    : undefined;
  const deployPlane = hostedDeployPlane(env);
  const publicUrl = resolvePublicOrigin(env.VAULT_PUBLIC_URL ?? "", {
    plane: deployPlane,
    allowLoopback: false,
  });
  const kernel = new HostedKernel({
    store,
    kek,
    sendEmail,
    publicUrl,
    approvalHmac: env.VAULT_APPROVAL_HMAC ? Buffer.from(env.VAULT_APPROVAL_HMAC, "hex") : undefined,
    deployPlane,
  });
  const host = env.VAULT_BIND_HOST ?? "0.0.0.0";
  const sessionSecret = env.VAULT_SESSION_SECRET ?? "";
  const identity = new OperatorIdentity({ store, sessionSecret, kek, sendEmail });
  const jwk = parseOidcPrivateJwk(env.VAULT_OIDC_PRIVATE_JWK);
  const oidcProvider = jwk
    ? createOauthProvider({
        issuer: publicUrl.replace(/\/$/, ""),
        kernel,
        sessionSecret,
        jwk,
        secureCookies: true,
      })
    : undefined;
  const inner =
    env.VAULT_AUTH_MODE === "test"
      ? testAuthResolver
      : identityAuthResolver({
          identity,
          kernel,
          secureCookies: true,
          oidcJwk: jwk,
          issuer: publicUrl.replace(/\/$/, ""),
        });
  const authResolver = hostedAuthResolver(env, inner);
  const http = createHostedServer({
    kernel,
    host,
    port: Number(env.PORT ?? env.VAULT_PORT ?? 8788),
    publicUrl: kernel.publicUrl,
    authResolver,
    identity,
    oidcProvider,
    secureCookies: true,
    siteRoot: env.VAULT_SITE_ROOT?.trim() || resolve(process.cwd(), "site/dist"),
    deployPlane,
  });
  const addr = await http.listen();
  console.error(`${PRODUCT_NAME} hosted on ${addr.host}:${addr.port} plane=${deployPlane}`);
  await new Promise<void>((resolveDone) => {
    const stop = () => {
      void http.close().then(() => {
        void store.close().then(() => {
          zeroKey(kek);
          resolveDone();
        });
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

const isMain = process.argv[1]?.includes("hosted/main");
if (isMain) {
  void startHosted();
}
