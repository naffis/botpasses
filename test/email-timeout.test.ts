import assert from "node:assert/strict";
import { test } from "node:test";
import { createResendSender } from "../src/hosted/email.ts";

test("Resend sender aborts a hung request after the timeout", async () => {
  const fetchFn: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const send = createResendSender("re_key", "Botpasses <noreply@staging.botpasses.com>", fetchFn, 25);
  const started = Date.now();
  await assert.rejects(send("a@b.co", "s", "<p>x</p>"), /Resend timeout after 25 ms/);
  assert.ok(Date.now() - started < 1000);
});

test("Resend sender passes through a normal response and clears the timer", async () => {
  let seen: RequestInit | undefined;
  const fetchFn: typeof fetch = async (_url, init) => {
    seen = init;
    return new Response(null, { status: 200 });
  };
  const send = createResendSender("re_key", "Botpasses <noreply@botpasses.com>", fetchFn, 5000);
  await send("a@b.co", "s", "<p>x</p>", "x");
  assert.ok(seen?.signal instanceof AbortSignal);
  assert.equal(seen?.signal?.aborted, false);
  const failing = createResendSender("re_key", "Botpasses <noreply@botpasses.com>", async () => new Response(null, { status: 422 }));
  await assert.rejects(failing("a@b.co", "s", "<p>x</p>"), /Resend 422/);
});
