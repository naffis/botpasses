/**
 * Store-and-connect recipes for MCP `setup` and recipe-aware Collect.
 * Separate from PROVIDERS (OAuth mint facts). Stripe here is a secret key, not Connect.
 */
import type { ItemKind, SetupRecipePublic } from "../../hosted-types.ts";

export const SETUP_PROVIDER_IDS = ["spotify", "github", "google", "slack", "stripe"] as const;
export type SetupProviderId = (typeof SETUP_PROVIDER_IDS)[number];

export type SetupRecipe = {
  id: SetupProviderId;
  displayName: string;
  suggestedName: string;
  kind: ItemKind;
  inject: string;
  allowedHosts: readonly string[];
  primaryHost: string;
  usernameRequired: boolean;
  connectAfter: boolean;
  dashboardUrl: string;
  hint: string;
};

export type { SetupRecipePublic };

const RECIPES: readonly SetupRecipe[] = [
  {
    id: "spotify",
    displayName: "Spotify",
    suggestedName: "SPOTIFY_SECRET",
    kind: "client_secret",
    inject: "client_credentials",
    allowedHosts: ["api.spotify.com", "accounts.spotify.com"],
    primaryHost: "api.spotify.com",
    usernameRequired: true,
    connectAfter: true,
    dashboardUrl: "https://developer.spotify.com/dashboard",
    hint: "Store the Client ID and Client Secret, not a user access token.",
  },
  {
    id: "stripe",
    displayName: "Stripe",
    suggestedName: "STRIPE_SECRET_KEY",
    kind: "secret",
    inject: "bearer",
    allowedHosts: ["api.stripe.com"],
    primaryHost: "api.stripe.com",
    usernameRequired: false,
    connectAfter: false,
    dashboardUrl: "https://dashboard.stripe.com/apikeys",
    hint: "Store the secret key (sk_), not a Stripe Connect OAuth client.",
  },
  {
    id: "github",
    displayName: "GitHub",
    suggestedName: "GITHUB_TOKEN",
    kind: "secret",
    inject: "bearer",
    allowedHosts: ["api.github.com"],
    primaryHost: "api.github.com",
    usernameRequired: false,
    connectAfter: false,
    dashboardUrl: "https://github.com/settings/personal-access-tokens",
    hint: "Store a fine-grained personal access token. Official GitHub MCP OAuth uses a baked-in app Botpasses does not ship.",
  },
  {
    id: "google",
    displayName: "Google",
    suggestedName: "GOOGLE_CLIENT_SECRET",
    kind: "client_secret",
    inject: "client_credentials",
    allowedHosts: [
      "www.googleapis.com",
      "gmail.googleapis.com",
      "sheets.googleapis.com",
      "oauth2.googleapis.com",
    ],
    primaryHost: "www.googleapis.com",
    usernameRequired: true,
    connectAfter: true,
    dashboardUrl: "https://console.cloud.google.com/apis/credentials",
    hint: "Store the OAuth client ID and secret, then Connect a Google account.",
  },
  {
    id: "slack",
    displayName: "Slack",
    suggestedName: "SLACK_BOT_TOKEN",
    kind: "secret",
    inject: "bearer",
    allowedHosts: ["slack.com"],
    primaryHost: "slack.com",
    usernameRequired: false,
    connectAfter: false,
    dashboardUrl: "https://api.slack.com/apps",
    hint: "Store a bot token (xoxb-) or user token (xoxp-). Slack-hosted MCP is a different product.",
  },
];

const BY_ID = new Map<SetupProviderId, SetupRecipe>(RECIPES.map((r) => [r.id, r]));
const BY_HOST = new Map<string, SetupRecipe>();
for (const recipe of RECIPES) {
  for (const host of recipe.allowedHosts) {
    BY_HOST.set(host.toLowerCase(), recipe);
  }
}

export function isSetupProviderId(value: string): value is SetupProviderId {
  return (SETUP_PROVIDER_IDS as readonly string[]).includes(value);
}

export function recipeById(id: string): SetupRecipe | undefined {
  if (!isSetupProviderId(id)) return undefined;
  switch (id) {
    case "spotify":
    case "github":
    case "google":
    case "slack":
    case "stripe":
      return BY_ID.get(id);
    default: {
      const _never: never = id;
      return _never;
    }
  }
}

/** Exact hostname, case-insensitive. Token hosts and API hosts map to the same recipe. */
export function recipeByHost(host: string): SetupRecipe | undefined {
  return BY_HOST.get(host.trim().toLowerCase());
}

export function publicRecipe(recipe: SetupRecipe): SetupRecipePublic {
  return {
    id: recipe.id,
    display_name: recipe.displayName,
    suggested_name: recipe.suggestedName,
    kind: recipe.kind,
    inject: recipe.inject,
    allowed_hosts: [...recipe.allowedHosts],
    primary_host: recipe.primaryHost,
    username_required: recipe.usernameRequired,
    dashboard_url: recipe.dashboardUrl,
    hint: recipe.hint,
    connect_after: recipe.connectAfter,
  };
}
