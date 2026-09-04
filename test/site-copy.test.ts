import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const SRC = join(root, "site/src");
const PUBLIC = join(root, "site/public");

/** From .cursor/rules/copy-voice.mdc. Case-insensitive, whole words. */
const BANNED = [
  "seamlessly",
  "effortlessly",
  "robust",
  "leverage",
  "elevate",
  "in today's fast-paced world",
  "it's important to note",
  "delve",
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(md|astro|ts|mjs|css|txt)$/.test(p)) acc.push(p);
  }
  return acc;
}

const files = [...walk(SRC), ...walk(PUBLIC)];

test("site copy has no em-dashes", () => {
  const hits = files
    .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => ({ f, i: i + 1, line })))
    .filter((x) => x.line.includes("—"))
    .map((x) => `${relative(root, x.f)}:${x.i}`);
  assert.deepEqual(hits, []);
});

test("site copy avoids the banned filler and hype words", () => {
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8").toLowerCase();
    for (const word of BANNED) {
      const re = new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);
      if (re.test(text)) hits.push(`${relative(root, f)}: ${word}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("site copy has no exclamation-mark enthusiasm in prose", () => {
  const hits: string[] = [];
  for (const f of files) {
    if (!/\.(md|astro)$/.test(f)) continue;
    let inCode = false;
    let inFrontmatter = false;
    let inScript = false;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/^---\s*$/.test(line)) {
        inFrontmatter = !inFrontmatter;
        return;
      }
      if (/^\s*```/.test(line)) inCode = !inCode;
      if (/<script(\s|>)/.test(line) && !/<\/script>/.test(line)) inScript = true;
      if (/<\/script>/.test(line)) {
        inScript = false;
        return;
      }
      if (inCode || inFrontmatter || inScript) return;
      // Prose only: strip inline code, JSX expressions, and HTML attributes before checking.
      const prose = line.replace(/`[^`]*`/g, "").replace(/\{[^}]*\}/g, "").replace(/<[^>]*>/g, "");
      if (/!(?!=)/.test(prose)) hits.push(`${relative(root, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("site never claims zero-knowledge except to deny it", () => {
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/zero-knowledge/gi)) {
      const before = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
      const ok = /\bnot\b|\bfalse\b|\brejects?\b|\bcannot\b|\bfails?\b/.test(before);
      assert.ok(ok, `${relative(root, f)} claims zero-knowledge near: ${text.slice(Math.max(0, m.index - 60), m.index + 20)}`);
    }
  }
});

test("site copy says botpasses.com, not 'this origin'", () => {
  const hits = files
    .filter((f) => /\.(md|astro)$/.test(f))
    .filter((f) => /this origin/i.test(readFileSync(f, "utf8")))
    .map((f) => relative(root, f));
  assert.deepEqual(hits, []);
});
