/**
 * First-party assets (console, auth, collect bundles, CSS, brand mark) are addressed by a
 * content hash so a year-long `immutable` cache can never pin a stale bundle to a page (B3).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { signInHtml } from "../src/hosted/auth-pages.ts";
import { hostedCollectHtml } from "../src/hosted/collect-page.ts";
import { CONSOLE_JS, assetContentHash, assetPath, hostedAsset, type AssetName } from "../src/hosted/hosted-assets.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { hostedOperatorHtml } from "../src/hosted/operator-page.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { cleanup, tempHome } from "./helpers.ts";

const NAMES: AssetName[] = [
  "auth.css",
  "console.css",
  "auth.js",
  "console.js",
  "collect.js",
  "mark.svg",
  "mark-on-dark.svg",
];

function split(name: AssetName): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

test("B3 every asset has a hashed path that serves the same body as the plain name, and only the hashed one is immutable", () => {
  for (const name of NAMES) {
    const { stem, ext } = split(name);
    const hashed = assetPath(name);
    assert.match(hashed, new RegExp(`^/assets/${stem}\\.[0-9a-f]{8}\\.${ext}$`), name);
    const viaHash = hostedAsset(hashed);
    const viaPlain = hostedAsset(`/assets/${name}`);
    assert.ok(viaHash && viaPlain, name);
    assert.equal(viaHash.body, viaPlain.body, name);
    assert.equal(viaHash.type, viaPlain.type, name);
    assert.equal(viaHash.immutable, true, `${name} hashed path is immutable`);
    assert.equal(viaPlain.immutable, false, `${name} plain path revalidates`);
    assert.equal(hashed, `/assets/${stem}.${assetContentHash(viaPlain.body)}.${ext}`, "hash is of the body");
  }
  assert.notEqual(assetContentHash("a"), assetContentHash("b"));
  assert.equal(hostedAsset("/assets/console.00000000.js"), undefined, "a stale hash is not served");
  assert.equal(hostedAsset(assetPath("console.js"))?.body, CONSOLE_JS);
});

test("B3 the console, auth, and collect pages reference the hashed names, never the plain ones", () => {
  const consoleHtml = hostedOperatorHtml({ hosted: true, nonce: "n" });
  for (const name of ["console.css", "console.js", "mark.svg", "mark-on-dark.svg"] as const) {
    assert.ok(consoleHtml.includes(`"${assetPath(name)}"`), `console references ${assetPath(name)}`);
  }
  assert.doesNotMatch(consoleHtml, /"\/assets\/[a-z]+\.(css|js|svg)"/);
  const signIn = signInHtml();
  for (const name of ["console.css", "auth.css", "auth.js"] as const) {
    assert.ok(signIn.includes(`"${assetPath(name)}"`), `sign-in references ${assetPath(name)}`);
  }
  assert.doesNotMatch(signIn, /"\/assets\/[a-z]+\.(css|js|svg)"/);
  const collect = hostedCollectHtml({ needId: "nid", origin: "https://staging.botpasses.com", nonce: "n" });
  assert.ok(collect.includes(`"${assetPath("collect.js")}"`));
  assert.doesNotMatch(collect, /"\/assets\/[a-z]+\.(css|js|svg)"/);
});

test("B3 over HTTP: hashed paths are cached immutable, plain names are no-cache, a stale hash is 404", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "assets.sqlite"));
  const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), publicUrl: "http://127.0.0.1:8788" });
  const http = createHostedServer({ kernel, host: "127.0.0.1", port: 0, deployPlane: "staging" });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  try {
    const hashed = await fetch(`${base}${assetPath("console.js")}`);
    assert.equal(hashed.status, 200);
    assert.equal(hashed.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(hashed.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal(hashed.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await hashed.text(), CONSOLE_JS);

    const plain = await fetch(`${base}/assets/console.js`);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get("cache-control"), "no-cache");
    assert.equal(await plain.text(), CONSOLE_JS);

    const css = await fetch(`${base}${assetPath("auth.css")}`);
    assert.equal(css.status, 200);
    assert.equal(css.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const stale = await fetch(`${base}/assets/console.00000000.js`);
    assert.equal(stale.status, 404);
  } finally {
    await http.close();
    await store.close();
    cleanup(home);
  }
});
