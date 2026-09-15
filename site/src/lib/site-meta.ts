/** Shared site identity for HTML meta, JSON-LD, and llms.txt. One place so SEO and GEO stay consistent. */

export const SITE_URL = "https://botpasses.com";
export const SITE_NAME = "Botpasses";
export const GITHUB = "https://github.com/naffis/botpasses";
export const SUPPORT_EMAIL = "support@botpasses.com";
export const SECURITY_EMAIL = "security@botpasses.com";

/** Product description shared by homepage metadata and JSON-LD. */
export const PRODUCT_DESCRIPTION =
  "Botpasses lets AI agents call APIs with your approval while keeping keys out of their conversations. Free to use and open source. Use botpasses.com or host it yourself.";

export const PRODUCT_TAGLINE = "API access for agents.";

export type JsonLd = Record<string, unknown>;

export function organizationLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    email: SUPPORT_EMAIL,
    description: PRODUCT_DESCRIPTION,
    logo: `${SITE_URL}/logo.png`,
    sameAs: [GITHUB],
    contactPoint: [
      { "@type": "ContactPoint", email: SUPPORT_EMAIL, contactType: "customer support" },
      { "@type": "ContactPoint", email: SECURITY_EMAIL, contactType: "security" },
    ],
  };
}

export function websiteLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: SITE_URL,
    description: PRODUCT_DESCRIPTION,
    inLanguage: "en",
    publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
  };
}

export function softwareApplicationLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    url: SITE_URL,
    image: `${SITE_URL}/og.png`,
    description: PRODUCT_DESCRIPTION,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Free to use",
    },
    featureList: [
      "Store a named API credential once",
      "MCP http_request attaches the key inside the vault",
      "Check agent approval before each API call",
      "No get_secret tool",
      "Open source, MIT licensed",
    ],
    sameAs: [GITHUB],
    author: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
  };
}

export function definedTermLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    name: "grant-vault",
    description:
      "A vault that checks an agent’s approval before attaching a stored credential to its API request. The model does not get the key. The vault process can decrypt credentials; it is not zero-knowledge.",
    url: `${SITE_URL}/docs/explanation/why-the-model-never-sees-the-value`,
    inDefinedTermSet: {
      "@type": "DefinedTermSet",
      name: "Botpasses terms",
      url: SITE_URL,
    },
  };
}

export function faqPageLd(faq: readonly { q: string; a: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

export function howToLd(input: {
  name: string;
  description: string;
  steps: readonly { name: string; text: string }[];
}): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: input.name,
    description: input.description,
    step: input.steps.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.name,
      text: s.text,
    })),
  };
}

export function techArticleLd(input: { title: string; description: string; url: string }): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: input.title,
    description: input.description,
    url: input.url,
    inLanguage: "en",
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL },
    publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
    mainEntityOfPage: { "@type": "WebPage", "@id": input.url },
  };
}

export function breadcrumbLd(items: readonly { href: string; label: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.label,
      item: c.href.startsWith("http") ? c.href : `${SITE_URL}${c.href}`,
    })),
  };
}

/** Split a docs FAQ markdown body (`## Question` + paragraph) into extractable pairs. */
export function faqFromMarkdown(body: string): { q: string; a: string }[] {
  return body
    .split(/^## /m)
    .slice(1)
    .map((block) => {
      const nl = block.indexOf("\n");
      const q = (nl < 0 ? block : block.slice(0, nl)).trim();
      const a = (nl < 0 ? "" : block.slice(nl + 1))
        .trim()
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\s+/g, " ");
      return { q, a };
    })
    .filter((f) => f.q.length > 0 && f.a.length > 0);
}
