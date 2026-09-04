---
title: Security disclosure
label: Security disclosure
description: How to report a vulnerability in Botpasses. Email security@botpasses.com, what to include, what to expect, and the machine-readable security.txt.
section: help
order: 4
---

If you find a security problem in Botpasses, the hosted service, or the repository, please tell us privately first.

## Contact

Email **[security@botpasses.com](mailto:security@botpasses.com)**. The same address is published in [`/.well-known/security.txt`](/.well-known/security.txt) (RFC 9116). Do not open a public GitHub issue for a vulnerability.

## What to include

- What you found and where (URL, route, tool, or file and line).
- Steps to reproduce, or a proof of concept. A test that fails is ideal.
- The impact you believe it has, in particular whether a secret value could reach a model, a transcript, a log, or a third party.

Please do not store real third-party credentials on `botpasses.com` while testing; use `staging.botpasses.com` and throwaway keys.

## What to expect

We reply from `security@botpasses.com` to confirm receipt and follow up with what we find. We will tell you when a fix ships and credit you in the [changelog](/changelog) if you want that. We ask that you give us time to fix the issue before publishing details.

## In scope

- `botpasses.com` and `staging.botpasses.com`: the console, MCP endpoint, OAuth server, and APIs.
- The `botpasses` repository: CLI, hosted server, connector, and crypto.

Findings that would let a model, chat transcript, or log see a stored value are the highest priority. The full list of who can and cannot decrypt is on the [Security](/security) page.

## Out of scope

- Reports against third-party services we use (Fly, Neon, Cloudflare, Resend, AWS). Report those to the vendor.
- Denial of service by volume.
- Findings that need a compromised operator device or account.
