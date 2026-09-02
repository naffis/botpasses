export type OtpEmail = {
  subject: string;
  html: string;
  text: string;
};

/** Sign-in / sign-up OTP. Keep a `>(digits)<` match for tests. */
export function buildOtpEmail(code: string, ttlMinutes: number): OtpEmail {
  const subject = "Your Botpasses sign-in code";
  const html = `<p>Use this code to sign in to Botpasses. It expires in ${String(ttlMinutes)} minutes.</p>
<p><strong>${code}</strong></p>
<p>If you did not request this, ignore this email.</p>`;
  const text = `Use this code to sign in to Botpasses. It expires in ${String(ttlMinutes)} minutes.\n\n${code}\n\nIf you did not request this, ignore this email.`;
  return { subject, html, text };
}
