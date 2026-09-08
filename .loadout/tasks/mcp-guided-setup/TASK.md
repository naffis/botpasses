# MCP guided setup

Single-loop task. Shared trunk. Topology tests failed (T-02/T-03/T-05 share files).

## Units

None. Implement T-01 through T-07 in one change:

1. Setup recipes (`src/hosted/providers/setup-recipes.ts`)
2. Hosted + local `setup` tool (XOR provider/host)
3. Recipe-aware `ensureNeedItem`, GET need `recipe`, Collect prefill
4. Collect `always_allow` + `persistFulfill` policy in the same txn
5. Idempotent setup states + `steps[]` + steer
6. Docs, Start.md order, CHANGELOG, research twin
7. Isolation + `lint` / `test` / `typecheck`

## Verify

```bash
npm run lint && npm test && npm run typecheck
```

Do not commit unless asked.
