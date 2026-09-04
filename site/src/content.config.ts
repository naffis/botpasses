import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";
import { DOC_SECTIONS } from "./lib/docs-nav.ts";

const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string().min(1),
    description: z.string().min(20).max(200),
    section: z.enum(DOC_SECTIONS),
    order: z.number().int().nonnegative(),
    // Short label for the sidebar and breadcrumb when the title is long.
    label: z.string().optional(),
  }),
});

const GITHUB_BLOB = "https://github.com/naffis/botpasses/blob/dev/";

/**
 * Repository CHANGELOG.md rendered on /changelog. Read at build time so the site never
 * lags the repo. Relative repo links become GitHub links; em-dashes in version headings
 * become a colon so the page follows the copy rule.
 */
const changelog = defineCollection({
  loader: {
    name: "repo-changelog",
    load: async ({ store, renderMarkdown, config }) => {
      const path = fileURLToPath(new URL("../CHANGELOG.md", config.root));
      const raw = readFileSync(path, "utf8")
        .replace(/^# Changelog\s*/m, "")
        .replace(/^(## [^\n]+?) \u2014 /gm, "$1: ")
        .replace(/ \u2014 /g, ". ")
        .replace(/\u2014/g, ", ")
        .replace(/\]\((docs\/[^)]+)\)/g, `](${GITHUB_BLOB}$1)`);
      store.clear();
      store.set({
        id: "changelog",
        data: {},
        body: raw,
        rendered: await renderMarkdown(raw),
      });
    },
  },
  schema: z.object({}),
});

export const collections = { docs, changelog };
