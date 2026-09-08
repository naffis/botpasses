/** Shared site identity for HTML meta, JSON-LD, and llms.txt. One place so SEO and GEO stay consistent. */

export const SITE_URL = "https://botpasses.com";
export const SITE_NAME = "Botpasses";
export const GITHUB = "https://github.com/naffis/botpasses";
export const SUPPORT_EMAIL = "support@botpasses.com";
export const SECURITY_EMAIL = "security@botpasses.com";

/** One-sentence product definition. Used as the default homepage description and in JSON-LD. */
export const PRODUCT_DESCRIPTION =
  "Botpasses is a grant-vault for AI agents. Store an API key once. Claude, Cursor, ChatGPT, or Grok call the API over MCP; the key never enters the model, the chat, or the logs.";

export const PRODUCT_TAGLINE = "Your agent can call Stripe. It never gets the key.";

export type JsonLd = Record<string, unknown>;

export function organizationLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    email: SUPPORT_EMAIL,
    description: PRODUCT_DESCRIPTION,
    logo: `${SITE_URL}/og.png`,
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
    description: PRODUCT_DESCRIPTION,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Free while in beta",
    },
    featureList: [
      "Store a named API credential once",
      "MCP http_request attaches the key inside the vault",
      "Operator approval before each inject",
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
      "A vault that decrypts a credential only at an approved inject, to attach it to an outbound API call. The model never receives the value. Not zero-knowledge.",
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
