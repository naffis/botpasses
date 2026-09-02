import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOtpEmail } from "../src/hosted/otp-email.ts";

test("OTP email names Botpasses, expiry, and keeps a digit run for tests", () => {
  const mail = buildOtpEmail("12345678", 10);
  assert.equal(mail.subject, "Your Botpasses sign-in code");
  assert.match(mail.html, />12345678</);
  assert.match(mail.html, /expires in 10 minutes/);
  assert.match(mail.html, /Botpasses/);
  assert.match(mail.html, /did not request/);
  assert.match(mail.text, /12345678/);
  assert.match(mail.text, /expires in 10 minutes/);
  assert.doesNotMatch(mail.html, /TODO|FIXME/);
});
