# test-bridge-a — cross-app bridge fixture (A)

A **test-only** app that, with its sibling [`test-bridge-b`](../test-bridge-b/README.md),
exercises inter-app tool calls, recursion/cycle detection, idempotency, and
trust-boundary/taint propagation across the app bridge (`callB`, `recurse`,
`idempotent`, `callIdempotent`, `cleanup`, `tainted`,
`callTaintedThenTrustBoundary`). Not a shipping integration.

## Connecting

**No connection required** — declares no `connections` block, reaches no external
system. See [`docs/connecting-apps.md`](../../../../../docs/connecting-apps.md)
for the shared connection machinery (not used here).
