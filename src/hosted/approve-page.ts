/**
 * Magic-link confirm page. GET /approve?token= renders this; nothing changes until the operator
 * submits the form, which POSTs the same token back. The HMAC token is the CSRF defence for the
 * email link, so the form carries no separate CSRF field.
 */
import { authDocument, escapeAttr, escapeHtml } from "./auth-shell.ts";

export function approveConfirmHtml(input: {
  token: string;
  clientName: string;
  itemName: string;
  last4: string;
  policy: string;
  taskDescription: string | null;
}): string {
  const task = input.taskDescription
    ? `<p class="muted">Reason given: ${escapeHtml(input.taskDescription)}</p>`
    : "";
  return authDocument({
    title: "Approve a request",
    testid: "approve-confirm",
    script: "",
    body: `
    <p><strong>${escapeHtml(input.clientName)}</strong> wants to use
      <strong>${escapeHtml(input.itemName)}</strong> (last four ${escapeHtml(input.last4)}).</p>
    <p>Policy: <code>${escapeHtml(input.policy)}</code>. One successful API call, then the approval is used up.</p>
    ${task}
    <form method="post" action="/approve">
      <input type="hidden" name="token" value="${escapeAttr(input.token)}" />
      <button type="submit" class="btn primary">Approve</button>
      <a class="btn" href="/console">Cancel</a>
    </form>`,
  });
}

export function approveDoneHtml(itemName: string): string {
  return authDocument({
    title: "Approved",
    testid: "approve-done",
    script: "",
    body: `<p>${escapeHtml(itemName)} is approved for one call. You can close this tab or
      <a href="/console">open the console</a>.</p>`,
  });
}

export function approveErrorHtml(message: string): string {
  return authDocument({
    title: "Link not usable",
    testid: "approve-error",
    script: "",
    body: `<p>${escapeHtml(message)}</p><p><a href="/console">Open the console</a> to see pending requests.</p>`,
  });
}
