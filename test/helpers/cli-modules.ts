/**
 * Runs one CLI command in-process and reports which hosted-only dependencies were loaded.
 * `pg` and `@aws-sdk/client-kms` are CommonJS, so they show up in the require cache even
 * when reached through ESM `import`.
 */
import { createRequire } from "node:module";
import { main } from "../../src/cli.ts";

const require = createRequire(import.meta.url);

function loaded(pkg: string): boolean {
  return Object.keys(require.cache).some((p) => p.includes(`/node_modules/${pkg}/`));
}

const io = { log: () => undefined, error: () => undefined, readStdin: async () => "" };
const code = await main(process.argv.slice(2), io);
if (process.argv[2] === "kek-rotate-probe") {
  // positive control: the store module pulls pg in
  await import("../../src/store/postgres.ts");
}
console.log(JSON.stringify({ code, pg: loaded("pg"), kms: loaded("@aws-sdk/client-kms"), oidc: loaded("oidc-provider") }));
