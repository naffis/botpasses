import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSetupProviderId,
  publicRecipe,
  recipeByHost,
  recipeById,
  SETUP_PROVIDER_IDS,
} from "../src/hosted/providers/setup-recipes.ts";

test("recipeById returns the five locked recipes", () => {
  assert.deepEqual([...SETUP_PROVIDER_IDS], ["spotify", "github", "google", "slack", "stripe"]);
  const spotify = recipeById("spotify");
  assert.equal(spotify?.suggestedName, "SPOTIFY_SECRET");
  assert.equal(spotify?.kind, "client_secret");
  assert.equal(spotify?.inject, "client_credentials");
  assert.deepEqual([...(spotify?.allowedHosts ?? [])], ["api.spotify.com", "accounts.spotify.com"]);
  assert.equal(spotify?.primaryHost, "api.spotify.com");
  assert.equal(spotify?.usernameRequired, true);
  assert.equal(spotify?.connectAfter, true);

  const stripe = recipeById("stripe");
  assert.equal(stripe?.suggestedName, "STRIPE_SECRET_KEY");
  assert.equal(stripe?.kind, "secret");
  assert.equal(stripe?.inject, "bearer");
  assert.deepEqual([...(stripe?.allowedHosts ?? [])], ["api.stripe.com"]);
  assert.equal(stripe?.connectAfter, false);
  assert.match(stripe?.hint ?? "", /sk_/);

  const github = recipeById("github");
  assert.equal(github?.suggestedName, "GITHUB_TOKEN");
  assert.equal(github?.kind, "secret");
  assert.equal(github?.connectAfter, false);

  const google = recipeById("google");
  assert.equal(google?.suggestedName, "GOOGLE_CLIENT_SECRET");
  assert.equal(google?.kind, "client_secret");
  assert.equal(google?.primaryHost, "www.googleapis.com");
  assert.equal(google?.connectAfter, true);
  assert.ok(google?.allowedHosts.includes("oauth2.googleapis.com"));

  const slack = recipeById("slack");
  assert.equal(slack?.suggestedName, "SLACK_BOT_TOKEN");
  assert.equal(slack?.inject, "bearer");
  assert.equal(slack?.connectAfter, false);
});

test("recipeByHost maps every listed host including token hosts to the same recipe", () => {
  assert.equal(recipeByHost("accounts.spotify.com")?.id, "spotify");
  assert.equal(recipeByHost("API.SPOTIFY.COM")?.id, "spotify");
  assert.equal(recipeByHost("api.stripe.com")?.connectAfter, false);
  assert.equal(recipeByHost("oauth2.googleapis.com")?.id, "google");
  assert.equal(recipeByHost("gmail.googleapis.com")?.primaryHost, "www.googleapis.com");
  assert.equal(recipeByHost("api.github.com")?.id, "github");
  assert.equal(recipeByHost("slack.com")?.id, "slack");
  assert.equal(recipeByHost("api.example.com"), undefined);
  assert.equal(recipeByHost(""), undefined);
});

test("unknown provider ids are rejected", () => {
  assert.equal(isSetupProviderId("spotify"), true);
  assert.equal(isSetupProviderId("stripe-connect"), false);
  assert.equal(recipeById("stripe-connect"), undefined);
  assert.equal(recipeById(""), undefined);
});

test("publicRecipe is value-free and uses snake_case", () => {
  const pub = publicRecipe(recipeById("spotify")!);
  assert.equal(pub.suggested_name, "SPOTIFY_SECRET");
  assert.equal(pub.primary_host, "api.spotify.com");
  assert.equal(pub.username_required, true);
  assert.equal(pub.connect_after, true);
  assert.ok(pub.allowed_hosts.includes("accounts.spotify.com"));
  assert.equal(JSON.stringify(pub).includes("secret_value"), false);
});
