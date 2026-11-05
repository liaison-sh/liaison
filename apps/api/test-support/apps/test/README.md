# test — kernel contract fixture

A **test-only** app that exercises the kernel's app contract: plain and gated
tools, a risky action, external-search, and produce/consume flows
(`listItems`, `createItem`, `riskyAction`, `gatedEcho`, `gatedEchoLater`, `gatedCreateItem`,
`externalSearch`, `gatedProduce`, `gatedConsume`). It exists to validate the app
runtime, gating, and tool-bridge in tests — it is not a shipping integration.

## Connecting

**No real connection to set up.** The manifest declares an `oauth2` connection
named `gitlab` (pointing at `gitlab.com`, scope `read_api`) **purely as a
contract fixture** — it lets tests drive the OAuth connection machinery
end-to-end. It is not meant to be connected in a real deployment; use the real
[`gitlab`](../gitlab/README.md) app for GitLab access.

For how the connection machinery it exercises actually works, see
[`docs/connecting-apps.md`](../../../../../docs/connecting-apps.md).
