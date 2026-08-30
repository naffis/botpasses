---
name: triaging-review-feedback
description: Triage unresolved PR review comments into a plan and address them. Use when a PR has review threads to work through.
---

# Triaging review feedback

## Trigger

A PR has open review threads (human or bot) to resolve.

## Workflow

1. **Fetch the threads.**

```bash
gh api repos/<owner>/<repo>/pulls/<n>/comments
```

2. **Bucket each comment:** must-fix (correctness/security), should-fix (clarity/maintainability), discuss (trade-off/disagreement), out-of-scope (file a ticket).
3. **Address must/should-fix** with focused commits; reply to each thread with what changed (or why not).
4. **For discuss/disagree**, respond with reasoning rather than silently complying or ignoring.
5. **Re-request review** once threads are addressed; don't resolve others' threads on their behalf unless that's the norm.

## Guardrails

- Don't make sweeping unrequested changes while "addressing feedback".
- A reviewer asked to find gaps will list some; fix what affects correctness/intent, push back on over-engineering.

## Pairs with

- rules: `commit-and-pr-conventions`
- skills: `reviewing-and-shipping`
- agents: `reviewer`
