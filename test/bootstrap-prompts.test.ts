import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BOOTSTRAP_PROMPTS,
  EXTRA_PROMPT_IDS,
  PRIMARY_PROMPT_IDS,
  promptById,
  type BootstrapPromptId,
} from "../site/src/lib/bootstrap-prompts.ts";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

test("bootstrap prompts cover hosted, local, self-host, and the four extras", () => {
  assert.deepEqual(
    BOOTSTRAP_PROMPTS.map((p) => p.id),
    [...PRIMARY_PROMPT_IDS, ...EXTRA_PROMPT_IDS],
  );
  for (const p of BOOTSTRAP_PROMPTS) {
    assert.ok(p.title.length > 0, p.id);
    assert.ok(p.heading.length > 0, p.id);
    assert.ok(p.blurb.length > 20, p.id);
    assert.ok(p.text.length > 40, p.id);
    assert.doesNotMatch(p.text, /—/, `${p.id} em-dash`);
    assert.doesNotMatch(p.blurb, /—/, `${p.id} blurb em-dash`);
    assert.doesNotMatch(p.text, /LastPass/i, p.id);
    assert.doesNotMatch(
      p.text,
      /paste (the |your )?(secret|key|token|credential)s? into (this )?chat/i,
      p.id,
    );
  }
  assert.equal(promptById("hosted").heading, "Hosted");
  assert.throws(() => promptById("missing" as BootstrapPromptId), /unknown bootstrap prompt/);
});

test("docs markdown embeds the shared prompt text", () => {
  const prompts = read("site/src/content/docs/prompts.md");
  assert.match(prompts, /title: Copy-paste prompts/);
  assert.match(prompts, /section: start/);
  for (const p of BOOTSTRAP_PROMPTS) {
    assert.ok(prompts.includes(p.text), `prompts.md missing ${p.id}`);
    assert.ok(prompts.includes(`## ${p.heading}`) || prompts.includes(`### ${p.heading}`), p.heading);
  }
  const guided = read("site/src/content/docs/how-to/guided-setup.md");
  assert.ok(guided.includes(promptById("hosted").text));
  assert.ok(guided.includes(promptById("first-api").text));
  assert.ok(read("site/src/content/docs/install.md").includes(promptById("local").text));
  assert.ok(read("site/src/content/docs/self-hosting.md").includes(promptById("self-host").text));
  const start = read("site/src/content/docs/start.md");
  assert.match(start, /\/docs\/prompts#hosted/);
  assert.match(start, /\/docs\/prompts#local/);
  for (const rel of [
    "site/src/content/docs/connect/claude.md",
    "site/src/content/docs/connect/claude-code.md",
    "site/src/content/docs/connect/cursor.md",
    "site/src/content/docs/connect/chatgpt.md",
    "site/src/content/docs/connect/grok.md",
  ]) {
    assert.match(read(rel), /\/docs\/prompts#hosted/, rel);
  }
  assert.match(read("site/src/content/docs/connect/grok.md"), /\/docs\/prompts#grok-redirect_uri/);
});
