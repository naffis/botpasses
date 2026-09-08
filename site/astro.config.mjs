import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import { rehypeDocsTables } from "./src/lib/rehype-docs.mjs";

// Old URLs that moved. Astro writes an HTML page with a meta refresh and a canonical
// link for each, so the old links keep working and search engines follow the move.
const redirects = {
  "/docs/how-to/connect-cursor": "/docs/connect/cursor",
  "/docs/how-to/connect-claude-code": "/docs/connect/claude-code",
  "/docs/connect/openai": "/docs/connect/chatgpt",
};

export default defineConfig({
  site: "https://botpasses.com",
  trailingSlash: "never",
  build: {
    format: "file",
    // The stylesheet is about 12 KB and the CSP already allows inline styles.
    inlineStylesheets: "always",
  },
  redirects,
  markdown: {
    rehypePlugins: [rehypeDocsTables],
    shikiConfig: { theme: "github-dark-default" },
  },
  integrations: [
    sitemap({
      // Redirect stubs are not canonical pages.
      filter: (page) => !Object.keys(redirects).some((from) => page === `https://botpasses.com${from}`),
      serialize(item) {
        return { ...item, lastmod: new Date().toISOString().slice(0, 10) };
      },
    }),
  ],
  vite: {
    build: {
      // The hosted CSP is `script-src 'nonce-…' 'self'` with no nonce on static pages, so an
      // inlined `<script type="module">` would be blocked. Keep every script and asset external.
      assetsInlineLimit: 0,
    },
    server: {
      // Base.astro imports the brand tokens from ../src/brand-visual.ts.
      fs: { allow: [".."] },
    },
  },
});
