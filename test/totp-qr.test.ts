import assert from "node:assert/strict";
import { test } from "node:test";
import encodeQR from "qr";
import decodeQR from "qr/decode.js";
import { groupTotpSecret, otpauthQrSvg, totpSecretFromOtpauth, TOTP_QR_OPTS } from "../src/hosted/totp-qr.ts";

const SAMPLE =
  "otpauth://totp/Botpasses:op%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Botpasses&algorithm=SHA1&digits=6&period=30";

function rasterize(matrix: boolean[][], scale: number): { width: number; height: number; data: Uint8ClampedArray } {
  const n = matrix.length;
  const width = n * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < n; y += 1) {
    const row = matrix[y];
    if (!row) continue;
    for (let x = 0; x < n; x += 1) {
      const dark = row[x] ? 0 : 255;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const i = ((y * scale + dy) * width + (x * scale + dx)) * 4;
          data[i] = dark;
          data[i + 1] = dark;
          data[i + 2] = dark;
          data[i + 3] = 255;
        }
      }
    }
  }
  return { width, height: width, data };
}

test("otpauth QR SVG is local black-on-white and round-trips the URI", () => {
  const svg = otpauthQrSvg(SAMPLE);
  assert.match(svg, /^<svg\b/);
  assert.doesNotMatch(svg, /JBSWY3DPEHPK3PXP/);
  assert.doesNotMatch(svg, /otpauth:/);
  const matrix = encodeQR(SAMPLE, "raw", TOTP_QR_OPTS);
  const decoded = decodeQR(rasterize(matrix, 4), { effort: Infinity, timeLimit: Infinity });
  assert.equal(decoded, SAMPLE);
});

test("otpauth QR helper rejects non-otpauth payloads", () => {
  assert.throws(() => otpauthQrSvg("https://example.com/?secret=JBSWY3DPEHPK3PXP"), /otpauth URL/);
});

test("manual TOTP key is the otpauth secret grouped by four", () => {
  assert.equal(totpSecretFromOtpauth(SAMPLE), "JBSWY3DPEHPK3PXP");
  assert.equal(groupTotpSecret("JBSWY3DPEHPK3PXP"), "JBSW Y3DP EHPK 3PXP");
});
