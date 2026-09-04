# 0006. Grant-vault, not zero-knowledge

Renumbered from 0003 on 2026-09-04; the number collided with [0003-first-party-operator-identity](0003-first-party-operator-identity.md).

- Status: accepted
- Date: 2026-08-31

## Context

Operators will store live API keys in Botpasses. Human password managers (1Password, Bitwarden, LastPass) encrypt in the client so the vendor never holds the key. Hosted Botpasses injects credentials via `http.request`, `vault run`, and trusted `POST /runtime/resolve`. The Fly process must decrypt to attach `Authorization`. A claim that "even we cannot read your keys" would be false the first time an agent calls Stripe.

## Decision

We will operate Botpasses as a **grant-vault**: the platform decrypts only at approved inject; no human or model reveal path returns an item `value`; public copy never says "zero-knowledge" or "even we cannot decrypt."

Local CLI stays closer to operator-held keys (`VAULT_MASTER_KEY` / `master.key`). Hosted comfort comes from no-reveal, KMS wrap of the platform KEK ([0007](0007-kms-wrapped-kek.md)), audit, and isolation tests that fail if a canary appears in the model.

## Consequences

- Support has no decrypt tool and no HTTP `get_secret`.
- Marketing and README must name "hosted process at inject" as a party that sees values.
- Client-side zero-knowledge for hosted inject is rejected; a user-run sidecar would be a different product.

## Alternatives considered

- Client-side ZK: operator passphrase encrypts; hosted stores ciphertext only; inject requires a sidecar. Breaks hosted `http.request`.
- False ZK marketing while keeping hosted inject. Dishonest; rejected.
