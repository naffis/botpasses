import { PRODUCT_NAME } from "../brand.ts";
import { authDocument, escapeAttr, escapeHtml } from "./auth-shell.ts";
import { assetPath } from "./hosted-assets.ts";

export function hostedCollectHtml(input: { needId: string; origin: string; nonce: string }): string {
  return authDocument({
    title: `${PRODUCT_NAME} collect`,
    heading: PRODUCT_NAME,
    nonce: input.nonce,
    script: assetPath("collect.js"),
    wide: true,
    body: `<p>Confirm the origin is ${escapeHtml(input.origin)} before typing a secret. Never paste it into chat.</p>
    <p><a href="/sign-in">Sign in</a></p>
    <details>
      <summary>Bootstrap token</summary>
      <form id="bootstrap">
        <label>Break-glass token <input name="token" autocomplete="off" /></label>
        <button type="submit">Use token</button>
      </form>
    </details>
    <div id="details" data-need-id="${escapeAttr(input.needId)}"></div>`,
  });
}

export function hostedCollectMissingHtml(): string {
  return authDocument({
    title: PRODUCT_NAME,
    heading: PRODUCT_NAME,
    script: "",
    body: `<p>Unknown collect request.</p>
    <p><a href="/console">Back to console</a></p>`,
  });
}
