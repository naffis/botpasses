# OIDC signing key rotation

`VAULT_OIDC_PRIVATE_JWK` is the RS256 private key that signs every OAuth access token this origin issues (and the ID tokens oidc-provider mints). Access tokens live 600 seconds; refresh tokens are opaque and are not affected by a key change.

`VAULT_OIDC_PREVIOUS_JWK` is the key being retired. While it is set:

- `/oauth/jwks` publishes both public keys, current first, each with its `kid` (the first 8 characters of the modulus `n`);
- every new token is signed with `VAULT_OIDC_PRIVATE_JWK` and carries its `kid` in the header;
- `/mcp` and `POST /oauth/revoke` verify a token with whichever of the two keys its `kid` names;
- the process refuses to boot if the two variables hold the same key, or if the previous value is not a private RS256 JWK.

Nothing is ever signed with the previous key, so it can be removed the moment the last token it signed has expired.

## Generate a key

```bash
node -e '
const { generateKeyPairSync } = require("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
console.log(JSON.stringify({ ...privateKey.export({ format: "jwk" }), alg: "RS256" }));
'
```

Keep the output out of the shell history and out of git. It is a Fly secret, nothing else.

## Rotate (per plane, staging first)

1. Generate the new key as above.
2. Move the current key to the previous slot and install the new one in a single `fly secrets set`, so there is no deploy where only one of them changes:

   ```bash
   fly secrets set \
     VAULT_OIDC_PREVIOUS_JWK="$(fly secrets get VAULT_OIDC_PRIVATE_JWK -a botpasses-staging 2>/dev/null || cat current.jwk)" \
     VAULT_OIDC_PRIVATE_JWK="$(cat new.jwk)" \
     -a botpasses-staging
   ```

   `fly secrets get` is not available on every Fly plan; if it is not, paste the current value from wherever it was generated. The Machine restarts.
3. Confirm: `curl -s https://staging.botpasses.com/oauth/jwks | jq '.keys[].kid'` lists two kids. Connect an MCP client (or refresh an existing one) and check the access token header `kid` matches the first key. An MCP call made with a token minted before the restart still works.
4. Wait at least 10 minutes (the access token lifetime), then unset the old key:

   ```bash
   fly secrets unset VAULT_OIDC_PREVIOUS_JWK -a botpasses-staging
   ```

5. Confirm `/oauth/jwks` lists one kid. Repeat for `botpasses-prod`.

## If the current key leaked

Skip the overlap: set `VAULT_OIDC_PRIVATE_JWK` to a new key and leave `VAULT_OIDC_PREVIOUS_JWK` unset. Every outstanding access token is refused at once (signature unknown); refresh tokens keep working, so connected clients recover on their next refresh without re-consent. Revoke an agent from the console Access panel if its refresh tokens must die too.

## Rollback

Put the old value back in `VAULT_OIDC_PRIVATE_JWK` and unset `VAULT_OIDC_PREVIOUS_JWK`. Tokens signed with the short-lived new key are refused; clients refresh.
