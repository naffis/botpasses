import type { EmailSender } from "./email.ts";

/**
 * Laptop delivery channel for plane `dev`. Writes the recipient and body (including the OTP)
 * to the supplied stream. Never call `logVaultEvent` with the code.
 */
export function createDevMailer(stream: NodeJS.WritableStream = process.stderr): EmailSender {
  return async (to, subject, html, text) => {
    const body = text?.trim() || html;
    stream.write(`[hosted-dev] to=${to} subject=${subject}\n${body}\n`);
  };
}
