/**
 * MCP `setup`: walk Collect, optional user Connect, and Always-allow without secret values.
 */
import { suggestedNameFromHost } from "../ids.ts";
import { assertSafePublicObject } from "../redact.ts";
import type { FindItemSummary, HostedGrantRecord, ItemKind, ItemPublic, SetupRecipePublic } from "../hosted-types.ts";
import type { Vault } from "../vault.ts";
import { hostAllowedBy } from "./connector.ts";
import { HttpError } from "./errors.ts";
import type { HostedKernel } from "./kernel.ts";
import type { ModelPrincipal } from "./auth.ts";
import { refreshItemName } from "./providers/oauth.ts";
import {
  isSetupProviderId,
  publicRecipe,
  recipeByHost,
  recipeById,
  type SetupProviderId,
  type SetupRecipe,
} from "./providers/setup-recipes.ts";
import { assertAllowedHostname } from "./ssrf.ts";

export type SetupDeps = {
  kernel: HostedKernel;
  principal: ModelPrincipal;
};

export type SetupStepState = "done" | "current" | "todo";

export type SetupStep = {
  id: string;
  label: string;
  state: SetupStepState;
  url?: string;
};

export type SetupTarget = {
  provider?: SetupProviderId;
  host?: string;
  recipe?: SetupRecipe;
  suggestedName: string;
  lookupHosts: readonly string[];
  primaryHost: string;
  kind: ItemKind;
  inject: string;
  usernameRequired: boolean;
  connectAfter: boolean;
};

type StepOpts = {
  connectAfter: boolean;
  stored: boolean;
  connected: boolean;
  standing: boolean;
  collectUrl?: string;
  connectUrl?: string;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function targetFromRecipe(
  recipe: SetupRecipe,
  keys: { provider?: SetupProviderId; host?: string },
): SetupTarget {
  return {
    ...keys,
    recipe,
    suggestedName: recipe.suggestedName,
    lookupHosts: recipe.allowedHosts,
    primaryHost: recipe.primaryHost,
    kind: recipe.kind,
    inject: recipe.inject,
    usernameRequired: recipe.usernameRequired,
    connectAfter: recipe.connectAfter,
  };
}

/** Exactly one of provider or host. Both (even when they agree) is 400. */
export function resolveSetupArgs(args: Record<string, unknown>): SetupTarget {
  const providerRaw = optionalString(args.provider);
  const hostRaw = optionalString(args.host)?.toLowerCase();
  if ((providerRaw && hostRaw) || (!providerRaw && !hostRaw)) {
    throw new HttpError(400, "setup requires exactly one of provider or host");
  }
  if (providerRaw) {
    if (!isSetupProviderId(providerRaw)) {
      throw new HttpError(
        400,
        "Unknown provider. Use spotify, github, google, slack, or stripe, or pass host.",
      );
    }
    const recipe = recipeById(providerRaw);
    if (!recipe) {
      throw new HttpError(
        400,
        "Unknown provider. Use spotify, github, google, slack, or stripe, or pass host.",
      );
    }
    return targetFromRecipe(recipe, { provider: recipe.id });
  }
  const host = hostRaw ?? "";
  assertAllowedHostname(host, [host]);
  const recipe = recipeByHost(host);
  if (recipe) return targetFromRecipe(recipe, { host });
  return {
    host,
    suggestedName: suggestedNameFromHost(host) ?? "API_KEY",
    lookupHosts: [host],
    primaryHost: host,
    kind: "secret",
    inject: "bearer",
    usernameRequired: false,
    connectAfter: false,
  };
}

export function vaultSetCommand(target: SetupTarget): string {
  const hosts = target.lookupHosts.map((h) => `--host ${h}`).join(" ");
  const username = target.usernameRequired ? " --username" : "";
  return `vault set ${target.suggestedName} ${hosts} --inject ${target.inject}${username}`;
}

export function exampleHttpRequest(target: SetupTarget, itemName?: string): Record<string, string> {
  const name = itemName ?? target.suggestedName;
  const id = target.recipe?.id;
  switch (id) {
    case "spotify":
      return { item_name: name, host: "api.spotify.com", method: "GET", path: "/v1/me" };
    case "stripe":
      return { item_name: name, host: "api.stripe.com", method: "GET", path: "/v1/balance" };
    case "github":
      return { item_name: name, host: "api.github.com", method: "GET", path: "/user" };
    case "google":
      return { item_name: name, host: "www.googleapis.com", method: "GET", path: "/oauth2/v2/userinfo" };
    case "slack":
      return { item_name: name, host: "slack.com", method: "GET", path: "/api/auth.test" };
    case undefined:
      return { item_name: name, host: target.primaryHost, method: "GET", path: "/" };
    default: {
      const _never: never = id;
      return _never;
    }
  }
}

function publicRecipeFor(target: SetupTarget): SetupRecipePublic | undefined {
  return target.recipe ? publicRecipe(target.recipe) : undefined;
}

function isRefreshItem(item: { name: string; inject: string }): boolean {
  return item.inject === "refresh" || item.name.endsWith("_REFRESH");
}

function hostsOverlap(allowed: readonly string[], wanted: readonly string[]): boolean {
  return wanted.some((h) => hostAllowedBy(allowed, h));
}

function buildSteps(opts: StepOpts): SetupStep[] {
  const steps: SetupStep[] = [];
  const storeState: SetupStepState = opts.stored ? "done" : "current";
  steps.push({
    id: "store",
    label: "Store the credential on Botpasses",
    state: storeState,
    ...(opts.collectUrl && storeState === "current" ? { url: opts.collectUrl } : {}),
  });
  if (opts.connectAfter) {
    const connectState: SetupStepState = !opts.stored ? "todo" : opts.connected ? "done" : "current";
    steps.push({
      id: "connect",
      label: "Connect the user account",
      state: connectState,
      ...(opts.connectUrl && connectState === "current" ? { url: opts.connectUrl } : {}),
    });
  }
  const allowBlocked = !opts.stored || (opts.connectAfter && !opts.connected);
  const allowState: SetupStepState = allowBlocked ? "todo" : opts.standing ? "done" : "current";
  steps.push({
    id: "allow",
    label: "Always allow this agent to use this credential",
    state: allowState,
  });
  const ready =
    opts.stored && (!opts.connectAfter || opts.connected) && opts.standing;
  steps.push({
    id: "ready",
    label: "Ready to call the API",
    state: ready ? "done" : "todo",
  });
  return steps;
}

function itemSummary(item: ItemPublic): FindItemSummary {
  return {
    name: item.name,
    kind: item.kind,
    last4: item.last4,
    allowed_hosts: item.allowedHosts,
    inject: item.inject,
    environment: item.environment,
  };
}

function retryArgs(target: SetupTarget): Record<string, string> {
  return target.provider ? { provider: target.provider } : { host: target.host ?? target.primaryHost };
}

function coveringGrant(grants: HostedGrantRecord[], itemId: string): HostedGrantRecord | undefined {
  return grants.find((g) => g.itemId === itemId && g.status === "active");
}

/** Connect only when the stored item is the recipe credential, not a leftover host-named bearer. */
function isRecipeCredential(item: ItemPublic, target: SetupTarget): boolean {
  if (!target.recipe) return false;
  return item.name === target.suggestedName && item.kind === target.kind && item.inject === target.inject;
}

export async function runHostedSetup(deps: SetupDeps, args: Record<string, unknown>): Promise<unknown> {
  const target = resolveSetupArgs(args);
  const dryRun = args.dry_run === true;
  const taskDescription = optionalString(args.task_description);
  const { kernel, principal } = deps;
  const environment = principal.environment;
  const recipe = publicRecipeFor(target);
  const items = (await kernel.listItems(principal.orgId, environment)).filter(
    (item) => !isRefreshItem(item) && hostsOverlap(item.allowedHosts, target.lookupHosts),
  );
  if (items.length > 1) {
    const payload = {
      status: "ambiguous" as const,
      items: items.slice(0, 5).map(itemSummary),
      truncated: items.length > 5,
      ...(recipe ? { recipe } : {}),
      steps: buildSteps({ connectAfter: target.connectAfter, stored: true, connected: false, standing: false }),
    };
    assertSafePublicObject("setup", payload);
    return payload;
  }
  const item = items[0];
  if (!item) {
    if (dryRun) {
      const payload = {
        status: "need_item" as const,
        suggested_name: target.suggestedName,
        host: target.primaryHost,
        message: "This credential is not stored yet. Call setup without dry_run to get a collect_url.",
        ...(recipe ? { recipe } : {}),
        steps: buildSteps({ connectAfter: target.connectAfter, stored: false, connected: false, standing: false }),
        retry: retryArgs(target),
      };
      assertSafePublicObject("setup", payload);
      return payload;
    }
    const need = await kernel.ensureNeedItem({
      orgId: principal.orgId,
      clientId: principal.clientId,
      environment,
      host: target.host ?? target.primaryHost,
      taskDescription,
    });
    const payload = {
      ...need,
      ...(recipe ? { recipe } : {}),
      steps: buildSteps({
        connectAfter: target.connectAfter,
        stored: false,
        connected: false,
        standing: false,
        collectUrl: need.collect_url,
      }),
      retry: retryArgs(target),
    };
    assertSafePublicObject("setup", payload);
    return payload;
  }
  const refresh = await kernel.findStoredItem(principal.orgId, environment, refreshItemName(item.name));
  const connectAfter = target.connectAfter && isRecipeCredential(item, target);
  const connected = Boolean(refresh) || !connectAfter;
  const grants = await kernel.listClientGrants(principal.orgId, principal.clientId);
  const grant = coveringGrant(grants, item.id);
  const standing = grant?.policy === "item_standing";
  if (connectAfter && !refresh) {
    let connect_url: string | undefined;
    let need_id: string | undefined;
    if (!dryRun) {
      const providerId = target.recipe?.id;
      if (!providerId) {
        throw new HttpError(500, "Connect setup requires a provider recipe");
      }
      const connect = await kernel.ensureConnectNeed({
        orgId: principal.orgId,
        clientId: principal.clientId,
        environment,
        providerId,
        sourceItemId: item.id,
        refreshItemName: refreshItemName(item.name),
        apiHost: target.primaryHost,
        taskDescription,
      });
      connect_url = connect.connect_url;
      need_id = connect.need_id;
    }
    const payload = {
      status: "user_connect_required" as const,
      item: itemSummary(item),
      grant_status: grant?.status ?? "none",
      ...(connect_url ? { connect_url } : {}),
      ...(need_id ? { need_id } : {}),
      ...(recipe ? { recipe } : {}),
      steps: buildSteps({
        connectAfter: true,
        stored: true,
        connected: false,
        standing,
        connectUrl: connect_url,
      }),
      retry: retryArgs(target),
    };
    assertSafePublicObject("setup", payload);
    return payload;
  }
  const status = standing ? "ready" : "ready_prompt";
  const payload = {
    status,
    item: itemSummary(item),
    grant_status: grant?.status ?? "none",
    ...(recipe ? { recipe } : {}),
    steps: buildSteps({
      connectAfter,
      stored: true,
      connected,
      standing,
    }),
    retry: exampleHttpRequest(target, item.name),
  };
  assertSafePublicObject("setup", payload);
  return payload;
}

export function runLocalSetup(vault: Vault, args: Record<string, unknown>): unknown {
  const target = resolveSetupArgs(args);
  const recipe = publicRecipeFor(target);
  const matches = vault
    .listItems()
    .filter((item) => !isRefreshItem(item) && hostsOverlap(item.allowedHosts, target.lookupHosts));
  if (matches.length > 1) {
    const payload = {
      status: "ambiguous" as const,
      items: matches.slice(0, 5).map((item) => ({
        name: item.name,
        kind: "secret",
        last4: item.last4,
        allowed_hosts: item.allowedHosts,
        inject: item.inject,
        environment: "local",
      })),
      truncated: matches.length > 5,
      ...(recipe ? { recipe } : {}),
      steps: buildSteps({ connectAfter: false, stored: true, connected: true, standing: true }),
    };
    assertSafePublicObject("setup", payload);
    return payload;
  }
  const item = matches[0];
  if (item) {
    const payload = {
      status: "ready" as const,
      item: {
        name: item.name,
        kind: "secret",
        last4: item.last4,
        allowed_hosts: item.allowedHosts,
        inject: item.inject,
        environment: "local",
      },
      ...(recipe ? { recipe } : {}),
      steps: buildSteps({ connectAfter: false, stored: true, connected: true, standing: true }),
      retry: exampleHttpRequest(target, item.name),
    };
    assertSafePublicObject("setup", payload);
    return payload;
  }
  const command = vaultSetCommand(target);
  const payload = {
    status: "need_item" as const,
    suggested_name: target.suggestedName,
    host: target.primaryHost,
    message: `No credential. Store it with: ${command}. Do not paste the secret into chat.`,
    ...(recipe ? { recipe } : {}),
    steps: buildSteps({ connectAfter: false, stored: false, connected: false, standing: false }),
  };
  assertSafePublicObject("setup", payload);
  return payload;
}
