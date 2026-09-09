import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { test } from "node:test";
import { findOpsIdentifierHits } from "../scripts/ops-identifiers.ts";

const root = process.cwd();
const SKIP_EXT = new Set([
  ".png",
  ".ico",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".woff",
  ".woff2",
  ".pdf",
]);

function assembled(parts: string[], sep: string): string {
  return parts.join(sep);
}

test("ops-identifier shapes match assembled fakes and ignore dated dump names", () => {
  const home = assembled(["", "Users", "someone", ".botpasses", ""], "/");
  const win = assembled(["", "Users", "someone", ""], "\\");
  const linear = assembled(["linear.app", "example-workspace", ""], "/");
  const neon = assembled(["copper", "river", "42424242"], "-");
  const dated = assembled(["restore", "drill", "20260905"], "-");
  const dump = assembled(["botpasses", "20260905T135436Z"], "-");

  assert.deepEqual(
    findOpsIdentifierHits(home).map((h) => h.kind),
    ["home_path"],
  );
  assert.deepEqual(
    findOpsIdentifierHits(win).map((h) => h.kind),
    ["home_path"],
  );
  assert.deepEqual(
    findOpsIdentifierHits(linear).map((h) => h.kind),
    ["linear_workspace_url"],
  );
  assert.deepEqual(
    findOpsIdentifierHits(neon).map((h) => h.kind),
    ["neon_project_slug"],
  );
  assert.deepEqual(findOpsIdentifierHits(dated), []);
  assert.deepEqual(findOpsIdentifierHits(dump), []);
  assert.deepEqual(findOpsIdentifierHits("NEON_PROD_PROJECT=\nLINEAR_BOTP10_URL=\nBOTP-10\n"), []);
});

test(".env.ops.example lists the keys and has no values", () => {
  const text = readFileSync(join(root, ".env.ops.example"), "utf8");
  assert.match(text, /^NEON_PROD_PROJECT=$/m);
  assert.match(text, /^LINEAR_BOTP10_URL=$/m);
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const cut = line.indexOf("=");
    assert.ok(cut > 0, `expected KEY= on ${line}`);
    assert.equal(line.slice(cut + 1), "", `${line.slice(0, cut)} must be empty in the example`);
  }
});

test("tracked text files contain no home path, Linear workspace URL, or Neon slug shape", () => {
  const listed = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  const hits: string[] = [];
  for (const rel of listed.split("\0")) {
    if (rel === "" || SKIP_EXT.has(extname(rel))) continue;
    const buf = readFileSync(join(root, rel));
    if (buf.includes(0)) continue;
    for (const hit of findOpsIdentifierHits(buf.toString("utf8"))) {
      hits.push(`${rel}: ${hit.kind} ${hit.match}`);
    }
  }
  assert.deepEqual(hits, []);
});
