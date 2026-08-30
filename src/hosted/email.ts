export type EmailSender = (to: string, subject: string, html: string) => Promise<void>;

export function createResendSender(apiKey: string, from: string): EmailSender {
  return async (to, subject, html) => {
    if (!from.trim()) {
      throw new Error("VAULT_EMAIL_FROM is required");
    }
    const res = await fetch("https://api.resend.com/emails", {
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
      }),
    });
    if (!res.ok) {
      throw new Error(`Resend ${res.status}`);
    }
  };
}
