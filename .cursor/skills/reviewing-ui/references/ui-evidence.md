# UI evidence: gathering it cheaply, honestly, and repeatably

Frontend work has a broken feedback loop by default: an agent can verify backend code by
running tests, but "does this look and feel right" has no exit code. This reference is
the discipline for closing that gap — how to *see* the UI, how to *act* on it like a
user, and how to avoid the classic ways agents fake UI verification.

## The three signals (use all, in this order)

| Signal | What it answers | Cost | Get it via |
| --- | --- | --- | --- |
| **Rendered markup / accessibility snapshot** | structure, labels, states, dead links, heading order, form wiring | cheap (text) | `curl` the route; Playwright `page.content()` / aria snapshot; browser-tool snapshot |
| **Screenshot** | visual truth: hierarchy, spacing, clipping, contrast, broken images | expensive (vision tokens) | Playwright `page.screenshot()`; browser-tool screenshot |
| **Interaction round-trip** | does acting like a user actually work, and does the UI respond | slowest | drive the real UI: click, type, submit; then re-verify |

**DOM-first, vision-second.** Run mechanical checks on the markup before spending vision
tokens: `rg -o 'href="[^"]*"'` for dead links and `href="#"` placeholders, one `h1` per
page, `img` alt attributes, every internal route returns 200, no lorem/placeholder text,
no internal jargon leaking into user-visible copy. Screenshot at *decision points* —
per-screen judgment, before/after a fix, milestone states — not after every micro-action.

**Look at what you capture.** You are a vision model; reading the screenshot is the
point. Check desktop AND a mobile width (and one odd width ~1000–1100px — responsive
bugs hide between canonical breakpoints). Embed key screenshots in your report with
`![](path)` so the human can see what you saw.

## Act like a user, verify like a skeptic

- **Never bypass the interface to make a check pass.** Injecting state into
  localStorage, writing rows to the DB, or calling the API directly to produce the state
  you were asked to reach through the UI proves nothing about the UI — it is the agent
  equivalent of writing the answers on your hand. If you cannot drive the flow through
  the real interface, that is itself a finding; report it.
- **Re-verify after every mutating action.** Agents that fail often don't notice they
  failed, and errors cascade. After a click/submit/edit: re-snapshot or re-fetch the
  rendered output and confirm the change actually landed. Never trust the app's own
  success toast/outcome card — a "Done!" chat message with a preview that silently never
  rebuilt is a known real-world failure class.
- **Exercise failure paths too.** Submit the empty form, the too-long value, the
  special-character input (`$`, quotes, emoji — `$` in replaced content is a classic
  regex-backreference corruption trigger). Watch what the user would see.
- **Console and network are part of the evidence.** Capture console errors/pageerrors
  during walkthroughs; a silent 500 or a hydration error is a finding even when the
  screen "looks fine". Record any known dev-only noise once, then ignore it.

## A minimal persistent browser harness

Use the project's existing tooling first (a browser MCP, Playwright test setup, or a
harness the repo already ships). When there is none, this pattern is cheap and robust: a
**persistent headless browser** with a CDP port, plus **one-shot probe scripts** that
attach, act, screenshot, and detach. One probe process per action; never hold a
long-lived CDP connection open across turns.

Setup (once):

```bash
mkdir -p /tmp/ui-harness && cd /tmp/ui-harness
npm init -y >/dev/null && npm i playwright >/dev/null
# write server.mjs + probe.mjs from below, then:
node server.mjs   # background; prints HARNESS_READY when up
```

`server.mjs` — the long-lived browser:

```js
import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const browser = await chromium.launchPersistentContext("/tmp/ui-harness/profile", {
  headless: true,
  viewport: { width: 1560, height: 960 },
  args: ["--remote-debugging-port=9666"],
});
const page = browser.pages()[0] ?? (await browser.newPage());
await page.goto(APP_URL, { waitUntil: "domcontentloaded" }).catch((e) => console.error("nav:", e.message));
console.log("HARNESS_READY url=" + page.url());
setInterval(() => {}, 60_000); // keep alive
```

`probe.mjs` — one-shot action + screenshot (`node probe.mjs <action.mjs> [shot.png]`;
the action module default-exports `async (page) => {}`; pass `-` to just screenshot):

```js
import { chromium } from "playwright";
import { resolve } from "node:path";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9666");
const ctx = browser.contexts()[0];
if (!ctx) throw new Error("no context — is server.mjs running?");
// Use a dedicated tab tagged window.name so probes never fight other tabs.
let page = null;
for (const p of ctx.pages()) {
  try { if ((await p.evaluate(() => window.name)) === "uireview") { page = p; break; } } catch {}
}
if (!page) {
  page = await ctx.newPage();
  await page.evaluate(() => { window.name = "uireview"; });
}
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
try {
  const actionPath = process.argv[2];
  if (actionPath && actionPath !== "-") await (await import(resolve(actionPath))).default(page);
  await page.screenshot({ path: process.argv[3] ?? "/tmp/ui-harness/shot.png" });
  console.log("URL=" + page.url());
  if (consoleLines.length) console.log("CONSOLE:\n" + consoleLines.slice(-30).join("\n"));
} finally {
  await browser.close(); // detaches CDP only; the server keeps the browser alive
}
```

Example action module:

```js
export default async function (page) {
  await page.goto("http://localhost:3000/settings", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForLoadState("networkidle");
}
```

Reuse a running harness if one exists (check for `HARNESS_READY` in its terminal) rather
than starting a second — two browsers against one dev server produce confusing state.

## Evidence hygiene

- Name artifacts by what they show (`settings-save-after-fix.png`), keep them in one
  scratch dir, reference them from the decision log.
- A claim in the log without an artifact or a reproducible command behind it is an
  opinion. Findings and fix-verifications both need evidence.
- Screenshots go stale the moment you edit: re-capture after fixes; never present a
  pre-fix screenshot as post-fix proof.
