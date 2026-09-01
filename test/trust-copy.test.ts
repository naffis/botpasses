import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTs(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

test("README and src/ do not claim zero-knowledge", () => {
  const needle = "zero-knowledge";
  const hits: string[] = [];
  const readme = readFileSync("README.md", "utf8");
  if (readme.toLowerCase().includes(needle)) hits.push("README.md");
  for (const file of walkTs("src")) {
    if (readFileSync(file, "utf8").toLowerCase().includes(needle)) hits.push(file);
  }
  assert.deepEqual(hits, []);
});
