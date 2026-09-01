import encodeQR from "qr";

/** ISO/IEC 18004 quiet zone is 4 modules. Medium ECC (15%) is the usual TOTP default. */
export const TOTP_QR_OPTS = { ecc: "medium", border: 4 } as const;

/**
 * Local black-on-white SVG for an otpauth provisioning URI.
 * Never a third-party QR image (that would leak the TOTP secret).
 */
export function otpauthQrSvg(otpauthUrl: string): string {
  if (!otpauthUrl.startsWith("otpauth://")) {
    throw new Error("TOTP QR payload must be an otpauth URL");
  }
  return encodeQR(otpauthUrl, "svg", TOTP_QR_OPTS);
}

export function totpSecretFromOtpauth(otpauthUrl: string): string {
  const secret = new URL(otpauthUrl).searchParams.get("secret") ?? "";
  if (!secret) throw new Error("otpauth URL missing secret");
  return secret;
}

/** Groups a Base32 TOTP secret in fours for manual entry. */
export function groupTotpSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}
