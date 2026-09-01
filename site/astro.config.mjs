import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://botpasses.com",
  trailingSlash: "never",
  build: {
    format: "file",
    inlineStylesheets: "never",
  },
  integrations: [sitemap()],
});
