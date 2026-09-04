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
