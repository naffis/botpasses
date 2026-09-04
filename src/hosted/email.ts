export type EmailSender = (to: string, subject: string, html: string, text?: string) => Promise<void>;

/** Resend normally answers in under a second; a hung socket must not hold an OTP request open. */
export const RESEND_TIMEOUT_MS = 10_000;

export function createResendSender(
  apiKey: string,
  from: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = RESEND_TIMEOUT_MS,
): EmailSender {
  return async (to, subject, html, text) => {
    if (!from.trim()) {
      throw new Error("VAULT_EMAIL_FROM is required");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject,
          html,
          ...(text ? { text } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Resend timeout after ${timeoutMs} ms`, { cause: err });
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`Resend ${res.status}`);
    }
  };
}

function escapeEmailHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Team invite (task 3.7). Every interpolation is escaped: org names and inviter emails are user
 * input. The link carries the one-time token and expires after seven days.
 */
export function inviteEmail(input: {
  orgName: string;
  inviterEmail: string;
  role: string;
  acceptUrl: string;
}): { subject: string; html: string; text: string } {
  const org = escapeEmailHtml(input.orgName);
  const inviter = escapeEmailHtml(input.inviterEmail);
  const role = escapeEmailHtml(input.role);
  const url = escapeEmailHtml(input.acceptUrl);
  return {
    subject: `You are invited to ${input.orgName} on Botpasses`,
    html:
      `<p>${inviter} invited you to join <strong>${org}</strong> on Botpasses as ${role}.</p>` +
      `<p><a href="${url}">Accept the invite</a></p>` +
      `<p>The link works for seven days. Sign in with this email address first if you are not signed in.</p>`,
    text:
      `${input.inviterEmail} invited you to join ${input.orgName} on Botpasses as ${input.role}.\n` +
      `Accept: ${input.acceptUrl}\n` +
      `The link works for seven days. Sign in with this email address first if you are not signed in.\n`,
  };
}
