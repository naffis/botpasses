# Root-cause descent

The discipline that turns "I found some problems" into "I found the TRUE cause and can prove
it." Governed by `no-shortcuts.mdc`: no symptom patches, no "good enough." A candidate cause is
a **hypothesis to be falsified**, not a conclusion.

## Table of contents

- [Mental model](#mental-model)
- [The descent loop](#the-descent-loop)
- [The "are we sure?" gates](#the-are-we-sure-gates-run-after-every-candidate)
- [Alternative-hypothesis elimination](#alternative-hypothesis-elimination)
- [Stop conditions](#stop-conditions--when-you-have-actually-reached-root)
- [One root, many roots, or a shared deeper root](#one-root-many-roots-or-a-shared-deeper-root)
- [Worked example](#worked-example)

## Mental model

Every defect has a **causal chain**:

```
observable symptom -> proximate cause -> intermediate cause(s) -> ROOT CAUSE
                                                                 (controllable invariant
                                                                  whose fix kills the
                                                                  whole class)
```

Most rushed investigations stop at the proximate cause ("the value was null", "the config was
wrong", "the timeout was too short") and patch THAT. That is a bandaid: the next input in the
same class breaks the same way. The job is to **descend the chain until you reach a node you
control whose correct fix prevents recurrence for the entire class** — and to PROVE you're
there, not assume it.

## The descent loop

For each confirmed defect, repeat until a stop condition is met — minimum **three** "why?"
descents; usually more:

1. **State the current node** precisely (what is true and wrong at this layer).
2. **Ask "why is THAT true?"** — name the mechanism one layer deeper.
3. **Demand evidence for the link.** Name the single artifact that would falsify it and check
   it (the code/log/value/test that proves this layer actually produced the next). No asserted
   links.
4. **Record the node + its evidence**, then descend again.

Never collapse the chain. Write every node, even the obvious ones — the obvious middle node is
often where the real lever hides.

## The "are we sure?" gates (run after EVERY candidate)

Before promoting any node to "root cause," it must pass ALL of these. A single failure means
you have NOT reached root — keep descending.

- **Completeness:** Does this cause explain **all** the symptoms/evidence, or only some? If
  only part, there is another cause or this isn't root.
- **Counterfactual:** If this node were corrected, would the defect be **impossible** (not
  just less likely)? If it could still occur, you're above the root.
- **Depth probe:** Is there a deeper cause that PRODUCES this one? Ask "why did this node end
  up in this state?" If there's an answer inside your control, the root is deeper.
- **Class test:** Does this explain why the WHOLE CLASS of inputs breaks, or only this one
  case? A root cause generalizes; an instance explanation doesn't.
- **Controllability:** Is this node something you can change (a contract, default, schema,
  stage logic, config)? If the next "why" lands outside your code (a genuine dependency
  limitation, or a fact the user supplied), THIS node may be root — but say so explicitly.

## Alternative-hypothesis elimination

A symptom can have more than one possible cause. Before committing:

- List every plausible cause that could independently produce this symptom.
- For each, find the evidence that confirms OR rules it out. Don't just confirm your favorite —
  actively try to falsify it and to support the rivals.
- If two causes both survive, you likely have **two roots** (or a shared deeper one) — handle
  both. Never pick the convenient one and drop the rest.

## Stop conditions — when you have actually reached root

Stop the descent ONLY when all hold, and write down which stopped you:

1. The node is **controllable** (a stage/contract/default/schema/config you own).
2. Its correct fix **prevents the whole class**, not just this instance (passes Class test +
   Counterfactual).
3. The next "why?" leaves your codebase (a genuine dependency/infra limitation, or a
   user-input fact) — and you've named that boundary.
4. The node is **corroborated by two independent signals** (e.g. a value + a log, or code + a
   test) — not one.

If you stopped for any other reason (ran out of time, it "feels deep enough"), you have NOT
finished. Say so and keep going.

## One root, many roots, or a shared deeper root

After processing all defects, look across them:

- **Consolidate:** several symptoms often share ONE deeper root (e.g. five failures all
  because a validation step never ran). Fixing the shared root is the high-leverage move —
  surface it explicitly.
- **Split:** one symptom may have multiple independent roots; list all.
- Prefer the deepest shared controllable node that, fixed correctly, removes the most defects
  without collateral damage.

## Worked example

> Symptom: a saved record shows `owner: null` for records created via the bulk-import path.

- Node 1 (proximate): the insert wrote `null`. *Evidence:* the row has `owner_id = null`.
- Why? Node 2: the import mapper didn't set `owner`. *Evidence:* the mapper output object has
  no `owner` key.
- Stop here = bandaid ("default owner to the importing user in the mapper"). Class test fails:
  any other caller that omits `owner` still writes null. Descend.
- Why does the insert accept a missing owner? Node 3: the insert path doesn't require `owner`.
  *Evidence:* the schema marks `owner_id` nullable; no validation at the boundary.
- Why is it nullable? Node 4 (ROOT): `owner` is a required invariant of a record but the
  persistence boundary never enforced it — every write path can silently omit it. *Evidence:*
  grep shows 3 write paths, 2 of which omit `owner`; only the UI path happened to set it.
- Stop: controllable (the persistence boundary / schema), fix prevents the class (all write
  paths), next "why" leaves the code (it's a design invariant we simply never encoded).
  Corroborated by the row data + the code paths.

Root cause = **the record's `owner` invariant is not enforced at the persistence boundary, so
any write path can omit it** — NOT "the bulk-import mapper forgot to set owner."
