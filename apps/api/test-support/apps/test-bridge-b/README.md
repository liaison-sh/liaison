# test-bridge-b — cross-app bridge fixture (B)

A **test-only** app paired with [`test-bridge-a`](../test-bridge-a/README.md) to
exercise cross-app tool calls and cycle detection via internal callbacks
(`internalCallback`, `callA`). Not a shipping integration.

## Connecting

**No connection required** — declares no `connections` block, reaches no external
system. See [`docs/connecting-apps.md`](../../../../../docs/connecting-apps.md)
for the shared connection machinery (not used here).
