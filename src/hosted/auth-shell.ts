import { PRODUCT_NAME } from "../brand.ts";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/** Shared first-party auth/collect chrome. No `<img>` (enroll/consent tests). */
export function authDocument(input: {
  title: string;
  heading?: string;
  testid?: string;
  body: string;
  script?: string;
  nonce?: string;
  wide?: boolean;
}): string {
  const heading = input.heading ?? input.title;
  const testid = input.testid ? ` data-testid="${escapeAttr(input.testid)}"` : "";
  const cardClass = input.wide ? "auth-card wide" : "auth-card";
  const nonce = input.nonce ? ` nonce="${escapeAttr(input.nonce)}"` : "";
  const scriptSrc = input.script === "" ? "" : (input.script ?? "/assets/auth.js");
  const scriptTag = scriptSrc
    ? `<script${nonce} src="${escapeAttr(scriptSrc)}"></script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/assets/console.css" />
  <link rel="stylesheet" href="/assets/auth.css" />
</head>
<body class="auth-body">
  <a class="skip" href="#content">Skip to content</a>
  <a class="brand auth-brand" href="/"><span class="brand-mark">${PRODUCT_NAME}</span></a>
  <main class="${cardClass}" id="content"${testid}>
    <h1>${escapeHtml(heading)}</h1>
    ${input.body}
    <p id="flash" class="flash" role="status"></p>
  </main>
  ${scriptTag}
</body>
</html>`;
}
