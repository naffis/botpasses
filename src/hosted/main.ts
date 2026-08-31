import { PRODUCT_NAME } from "../brand.ts";
import { parseKek } from "./kek.ts";
import { HostedKernel } from "./kernel.ts";
import { createHostedServer } from "./http.ts";
import { createResendSender } from "./email.ts";
import { assertHostedBoot, HOSTED_CONFIG_EXIT } from "./boot.ts";
import { PostgresStore } from "../store/postgres.ts";
import { clerkAuthResolver } from "./clerk-auth.ts";
import { hostedAuthResolver, testAuthResolver } from "./auth.ts";

export async function startHosted(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    assertHostedBoot(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(HOSTED_CONFIG_EXIT);
  }
  const kek = parseKek(env.VAULT_KEK ?? "");
  const store = await PostgresStore.open(env.DATABASE_URL ?? "");
  const sendEmail = env.RESEND_API_KEY
    ? createResendSender(env.RESEND_API_KEY, env.VAULT_EMAIL_FROM ?? "")
    : undefined;
  const deployPlane = env.VAULT_DEPLOY_PLANE === "staging" ? "staging" : "production";
  const kernel = new HostedKernel({
    store,
    kek,
    sendEmail,
    publicUrl: env.VAULT_PUBLIC_URL ?? "http://127.0.0.1:8788",
    approvalHmac: env.VAULT_APPROVAL_HMAC ? Buffer.from(env.VAULT_APPROVAL_HMAC, "hex") : undefined,
    deployPlane,
  });
  const host = env.VAULT_BIND_HOST ?? "0.0.0.0";
  const publicUrl = env.VAULT_PUBLIC_URL ?? "";
  if (host !== "127.0.0.1" && host !== "localhost" && !publicUrl.startsWith("https://")) {
    console.error("Refusing non-loopback bind without https VAULT_PUBLIC_URL");
    process.exit(HOSTED_CONFIG_EXIT);
  }
  const inner = env.VAULT_AUTH_MODE === "test" ? testAuthResolver : clerkAuthResolver;
  const authResolver = hostedAuthResolver(env, inner);
  const http = createHostedServer({
    kernel,
    host,
    port: Number(env.PORT ?? env.VAULT_PORT ?? 8788),
    publicUrl: kernel.publicUrl,
    authResolver,
    clerkIssuer: env.CLERK_FRONTEND_API ? `https://${env.CLERK_FRONTEND_API}` : undefined,
  });
  const addr = await http.listen();
  console.error(`${PRODUCT_NAME} hosted on ${addr.host}:${addr.port} plane=${deployPlane}`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      void http.close().then(() => {
        void store.close().then(() => resolve());
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
