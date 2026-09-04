---
title: Why the model never sees the value
label: Why the model never sees the value
description: What goes wrong when a secret enters a model's context window, how Botpasses keeps values out of it, and what "grant-vault, not zero-knowledge" means.
section: explanation
order: 1
---

## The problem with secrets in context

Anything in a model's context window can end up anywhere the transcript goes: provider logs, a tool result echoed back to the user, a later turn that summarises the conversation, a prompt injection that asks the model to repeat what it knows, or a screenshot. Environment variables are not much better: an agent that can run `env` or read `process.env` can print them.

Once a key has been in context, you have to assume it leaked. Rotating it is the only fix.

## What Botpasses does instead

Botpasses is a **grant-vault**. Values stay inside the Botpasses process. The model only ever handles names.

1. The operator stores a credential once. It is encrypted at rest.
2. An agent asks for an API call by host, method, and path (`http_request`). It does not ask for the key.
3. Botpasses finds the credential by host, checks that this agent has an **approval** for it, and asks the operator if not.
4. Botpasses decrypts the value inside its own process, attaches it to the outbound HTTPS request (an `Authorization` header, HTTP Basic, or a raw header), and sends the request to the allowed host only.
5. The response comes back with the credential and any minted access tokens replaced by `[redacted]`.

The point where the plaintext leaves the vault is called **inject**. On the hosted service the inject targets are the outbound connector call and `POST /runtime/resolve` for trusted (non-model) processes. On the local CLI the inject target is the child process environment of `vault run`. None of these is the model.

## There is no reveal path

No MCP tool, HTTP route, CLI command, console screen, email, or audit row returns a stored value. `get_secret` does not exist. Support staff do not have a decrypt tool. Tests in the repository store a canary value and fail if it appears in any MCP result, REST model payload, Inbox JSON, email, collect page, or audit entry.

## Not zero-knowledge, and why we say so

Password managers for people encrypt in the client so the vendor cannot read what you store. Botpasses cannot make that claim: to attach a key to a request, the hosted process has to decrypt it. The parties that can decrypt are the hosted process at inject, and anyone who holds both the AWS KMS role and the database. The model, the chat transcript, logs, and staff without both of those cannot.

We think an honest "grant-vault" is more useful to you than a false "zero-knowledge". The decision is recorded in [ADR 0003](https://github.com/naffis/botpasses/blob/dev/docs/adr/0006-grant-vault-trust-model.md) and the full table of who sees what is on the [Security](/security) page.

## What this does not protect against

- An agent that is approved to use a credential can call any endpoint on the allowed host with it. Approvals are per credential and host, not per path or method. Use `prompt` approvals for anything sensitive and revoke standing approvals when a task is done.
- The API you call sees the credential, as it must.
- A compromised operator account. Protect it with your authenticator and keep the backup codes offline.
