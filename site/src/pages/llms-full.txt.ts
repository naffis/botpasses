import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { renderLlmsFull } from "../lib/llms-txt.ts";

export const GET: APIRoute = async () => {
  const docs = await getCollection("docs");
  return new Response(renderLlmsFull(docs), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
