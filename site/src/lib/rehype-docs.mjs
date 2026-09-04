/**
 * Rehype plugin for the docs Markdown pipeline.
 *
 * - Wraps every `<table>` in `<div class="table-wrap">` so wide reference tables scroll
 *   inside their own box instead of overflowing the page at 390 px.
 * - Labels each table with the nearest preceding heading (`aria-label`) and marks header
 *   cells with `scope="col"`.
 * - Gives `<pre>` blocks `tabindex="0"` so keyboard users can scroll long code samples.
 *
 * Written without a dependency on unist-util-visit so the site adds no packages.
 */

function textOf(node) {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if (Array.isArray(node.children)) return node.children.map(textOf).join("");
  return "";
}

const HEADINGS = new Set(["h1", "h2", "h3", "h4"]);

function markHeaderCells(table) {
  for (const section of table.children ?? []) {
    if (section.tagName !== "thead") continue;
    for (const row of section.children ?? []) {
      for (const cell of row.children ?? []) {
        if (cell.tagName === "th") {
          cell.properties = { ...cell.properties, scope: "col" };
        }
      }
    }
  }
}

export function rehypeDocsTables() {
  return (tree) => {
    let lastHeading = "";
    const walk = (parent) => {
      const children = parent.children ?? [];
      for (let i = 0; i < children.length; i += 1) {
        const node = children[i];
        if (node.type !== "element") continue;
        if (HEADINGS.has(node.tagName)) lastHeading = textOf(node).trim();
        if (node.tagName === "pre") {
          node.properties = { ...node.properties, tabIndex: 0 };
        }
        if (node.tagName === "table") {
          markHeaderCells(node);
          if (lastHeading) {
            node.properties = { ...node.properties, "aria-label": lastHeading };
          }
          children[i] = {
            type: "element",
            tagName: "div",
            properties: { className: ["table-wrap"] },
            children: [node],
          };
          continue;
        }
        walk(node);
      }
    };
    walk(tree);
  };
}
