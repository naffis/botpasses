import { PRODUCT_NAME } from "../brand.ts";

export function hostedCollectHtml(input: { needId: string; origin: string; nonce: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${PRODUCT_NAME} collect</title>
  <link rel="stylesheet" href="/assets/auth.css" />
</head>
<body>
  <main>
    <h1>${PRODUCT_NAME}</h1>
    <p>Confirm the origin is ${escapeHtml(input.origin)} before typing a secret. Never paste it into chat.</p>
    <p><a href="/sign-in">Sign in</a></p>
    <details>
      <summary>Bootstrap token</summary>
      <form id="bootstrap">
        <label>Break-glass token <input name="token" autocomplete="off" /></label>
        <button type="submit">Use token</button>
      </form>
    </details>
    <p id="flash" class="flash"></p>
    <div id="details" data-need-id="${escapeAttr(input.needId)}"></div>
  </main>
  <script nonce="${escapeAttr(input.nonce)}" src="/assets/collect.js"></script>
</body>
</html>`;
}

export function hostedCollectMissingHtml(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>${PRODUCT_NAME}</title>
<link rel="stylesheet" href="/assets/auth.css" /></head>
<body><main><h1>${PRODUCT_NAME}</h1><p>Unknown collect request.</p></main></body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
