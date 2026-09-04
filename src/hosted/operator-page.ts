import { PRODUCT_NAME } from "../brand.ts";
import type { VaultEnvName } from "../hosted-types.ts";
import { environmentsForDeployPlane } from "./deploy-plane.ts";
import { consoleDialogsHtml } from "./console-dialogs.ts";
import { consolePanelsHtml } from "./console-panels.ts";

/** Store and issue default to the plane's own environment (D13). */
export function defaultEnvironmentForPlane(plane: VaultEnvName): VaultEnvName {
  return plane === "staging" ? "staging" : "production";
}

/** Operator console HTML. `deployPlane` controls which environments Store, Issue, and the list expose. */
export function hostedOperatorHtml(
  opts: { hosted?: boolean; nonce?: string; deployPlane?: VaultEnvName } = {},
): string {
  const hosted = Boolean(opts.hosted);
  const plane = opts.deployPlane ?? "production";
  const defaultEnv = defaultEnvironmentForPlane(plane);
  const envAttr = environmentsForDeployPlane(plane).join(",");
  const signin = hosted
    ? `<p id="console-signin" class="signin" data-testid="console-signin"><a href="/sign-in">Sign in</a> or <a href="/sign-up">Create account</a></p>`
    : `<p id="console-signin" class="signin" data-testid="console-signin">Local operator console. Sign in is not required on loopback.</p>`;
  const planeLabel = plane === "staging" ? `<p class="plane-label" data-testid="plane-label">Staging</p>` : "";
  return `<!doctype html>
<html lang="en" data-deploy-plane="${plane}" data-environments="${envAttr}" data-default-environment="${defaultEnv}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>${PRODUCT_NAME} console</title>
  <link rel="icon" href="/assets/mark.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/assets/console.css" />
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="app-shell" data-testid="app-shell">
    <aside class="rail">
      <a class="brand" href="/console#inbox"><img src="/assets/mark.svg" alt="" width="28" height="28" /><span class="brand-mark">${PRODUCT_NAME}</span></a>
      ${planeLabel}
      <nav class="rail-nav" aria-label="Console">
        <a class="nav-link" href="#inbox" data-nav="inbox" data-testid="nav-inbox">Inbox <span id="inbox-badge" class="badge" data-count="0" aria-label="0 waiting">0</span></a>
        <a class="nav-link" href="#credentials" data-nav="credentials" data-testid="nav-credentials">Credentials</a>
        <a class="nav-link" href="#agents" data-nav="agents" data-testid="nav-agents">Agents</a>
      </nav>
      <div class="rail-foot">
        <a class="nav-link" href="#account" data-nav="account" data-testid="nav-account">Account</a>
        <button type="button" id="sign-out" class="nav-link nav-button" data-testid="sign-out">Sign out</button>
        ${signin}
        <details id="breakglass" hidden data-testid="breakglass">
          <summary>Bootstrap token</summary>
          <form id="bootstrap">
            <label for="bootstrap-token">Break-glass token</label>
            <input id="bootstrap-token" name="token" type="password" autocomplete="off" />
            <button type="submit" class="btn-ghost">Use token</button>
          </form>
        </details>
      </div>
    </aside>
    <div class="workspace">
      <header class="page-head">
        <div>
          <h1 id="page-title">Credentials</h1>
          <p id="page-lede" class="lede">Named credentials your agents can use. Values are never shown, only the last four characters.</p>
        </div>
        <div class="toolbar">
          <button type="button" id="open-store" class="btn-primary" data-testid="open-store">Store credential</button>
        </div>
      </header>
      <div id="flash" class="flash" role="status"></div>
      <div id="signed-out-gate" class="card gate-card" hidden>
        <h2>Sign in to continue</h2>
        <p>This tab has no operator session.</p>
        <p class="toolbar">
          <a class="btn btn-primary" href="/sign-in">Sign in</a>
          <a class="btn btn-ghost" href="/sign-up">Create account</a>
        </p>
      </div>
      <main id="main">
        ${consolePanelsHtml(plane, defaultEnv)}
      </main>
    </div>
  </div>
  ${consoleDialogsHtml(plane, defaultEnv)}
  <script${opts.nonce ? ` nonce="${opts.nonce}"` : ""} src="/assets/console.js"></script>
</body>
</html>`;
}
