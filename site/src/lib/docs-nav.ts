/** Docs sidebar order and helpers shared by the docs index, the docs layout, and llms.txt. */

export const DOC_SECTIONS = ["start", "how-to", "connect", "reference", "explanation", "help"] as const;

export type DocSection = (typeof DOC_SECTIONS)[number];

export const SECTION_LABELS: Record<DocSection, string> = {
  start: "Start",
  "how-to": "How to",
  connect: "Connect an agent",
  reference: "Reference",
  explanation: "Explanation",
  help: "Help",
};

export type DocEntry = {
  id: string;
  data: { title: string; description: string; section: DocSection; order: number; label?: string };
};

export type NavItem = { href: string; title: string; label: string; description: string; section: DocSection };

export function docHref(id: string): string {
  return `/docs/${id}`;
}

export function sortDocs<T extends DocEntry>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const sa = DOC_SECTIONS.indexOf(a.data.section);
    const sb = DOC_SECTIONS.indexOf(b.data.section);
    if (sa !== sb) return sa - sb;
    if (a.data.order !== b.data.order) return a.data.order - b.data.order;
    return a.data.title.localeCompare(b.data.title);
  });
}

export function toNavItems(entries: DocEntry[]): NavItem[] {
  return sortDocs(entries).map((e) => ({
    href: docHref(e.id),
    title: e.data.title,
    label: e.data.label ?? e.data.title,
    description: e.data.description,
    section: e.data.section,
  }));
}

export function groupBySection(items: NavItem[]): { section: DocSection; label: string; items: NavItem[] }[] {
  return DOC_SECTIONS.map((section) => ({
    section,
    label: SECTION_LABELS[section],
    items: items.filter((i) => i.section === section),
  })).filter((g) => g.items.length > 0);
}

export function neighbours(items: NavItem[], href: string): { prev?: NavItem; next?: NavItem } {
  const i = items.findIndex((x) => x.href === href);
  if (i < 0) return {};
  return { prev: items[i - 1], next: items[i + 1] };
}
