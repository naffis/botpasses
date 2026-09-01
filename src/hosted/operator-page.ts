import { PRODUCT_NAME } from "../brand.ts";

export function hostedOperatorHtml(opts: { hosted?: boolean; nonce?: string } = {}): string {
  const hosted = Boolean(opts.hosted);
  const signin = hosted
    ? `<p id="console-signin" data-testid="console-signin"><a href="/sign-in">Sign in</a> or <a href="/sign-up">Create account</a></p>`
    : `<p id="console-signin" data-testid="console-signin">Local operator console. Sign in is not required on loopback.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${PRODUCT_NAME}</title>
  <link rel="stylesheet" href="/assets/console.css" />
</head>
<body>
  <main>
    <h1>${PRODUCT_NAME}</h1>
    <p>Store named credentials once. Agents request use. You authorize. The runtime gets the value. The model never does.</p>
    <div class="banner">Issue a Grok Bot token once. After Grok is connected, ask it in plain language (for example get my Spotify profile). Grok calls the API in the same turn. You approve here if asked. You do not need to tell it to use Botpasses. Never paste a secret into Grok.</div>
    ${signin}
    <details>
      <summary>Bootstrap token</summary>
      <form id="bootstrap">
        <label>Break-glass token <input name="token" type="password" autocomplete="off" /></label>
        <button type="submit">Use token</button>
      </form>
    </details>
    <p id="flash" class="flash"></p>
    <h2>Grok Bot</h2>
    <p>MCP URL: <code id="mcp_url"></code></p>
    <p>Connect that URL with Authorization Bearer on the issued token. Then say what you want (get my Spotify profile).</p>
    <form id="grok">
      <label>Client name <input name="name" value="grok" /></label>
      <button type="submit">Issue Grok Bot token</button>
    </form>
    <pre id="grok_once"></pre>
    <h2>Store item</h2>
    <form id="store">
      <label>Name <input name="name" required placeholder="SPOTIFY_TOKEN" /></label>
      <label>Kind
        <select name="kind"><option value="secret">secret</option><option value="login">login</option></select>
      </label>
      <label>Environment
        <select name="environment"><option value="staging">staging</option><option value="production">production</option></select>
      </label>
      <label>Value <input name="value" type="password" autocomplete="off" /></label>
      <label>Username (login) <input name="username" /></label>
      <label>Allowed hosts (comma) <input name="allowed_hosts" placeholder="api.spotify.com" /></label>
      <label>Inject
        <select name="inject">
          <option value="bearer" selected>bearer</option>
          <option value="basic">basic</option>
          <option value="header:Authorization">header:Authorization</option>
        </select>
      </label>
      <button type="submit">Store</button>
    </form>
    <h2>Items</h2>
    <div id="items"></div>
    <h2>Rotate</h2>
    <form id="rotate">
      <label>Item id <input name="id" /></label>
      <label>New value <input name="value" type="password" autocomplete="off" /></label>
      <button type="submit">Rotate</button>
    </form>
    <h2>Inbox</h2>
    <div id="inbox"></div>
    <h2>Approve by code</h2>
    <form id="code">
      <label>8-digit code <input name="code" maxlength="8" /></label>
      <button type="submit">Approve</button>
    </form>
    <section id="access-panel" data-testid="access-panel">
      <h2>Access</h2>
      <p id="access-empty" data-testid="access-empty" hidden>No clients, grants, or other sessions.</p>
      <h3>Clients</h3>
      <div id="access-clients"></div>
      <h3>Grants</h3>
      <div id="access-grants"></div>
      <h3>Sessions</h3>
      <div id="access-sessions"></div>
      <h3>Activity</h3>
      <div id="access-activity"></div>
    </section>
    <dialog id="confirm" data-testid="item-delete-confirm">
      <p>Confirm this change. It is not sent until you click Confirm.</p>
      <button type="button" id="confirm-yes">Confirm</button>
      <button type="button" onclick="this.closest('dialog').close()">Cancel</button>
    </dialog>
    <dialog id="access-revoke" data-testid="access-revoke-confirm">
      <p>Revoke this credential?</p>
      <button type="button" id="revoke-yes">Confirm</button>
    </dialog>
  </main>
  <script${opts.nonce ? ` nonce="${opts.nonce}"` : ""} src="/assets/console.js"></script>
</body>
</html>`;
}
