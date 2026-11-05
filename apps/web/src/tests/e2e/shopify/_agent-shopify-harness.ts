// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared harness for the four "agent drives Shopify" e2e scenarios.
//
// P4c-T21b — WHAT CHANGED AND WHY.
//
// This harness used to build a CANNED SSE stream (`buildToolChainSse`) and
// serve it from `page.route("**\/api/agent/chat")`. Every "tool result" in those
// scenarios was a literal the test wrote itself, so what they proved was that
// the retired agent panel renders a transcript — not that a Shopify-namespaced
// tool is reachable, permitted, gated or correct. The panel is gone and so is
// that route: a turn now runs on the SERVER and streams over the websocket.
//
// The replacement scripts only the MODEL (`agent-turn.ts` ->
// `POST /api/_test/agent-script`). Each tool call in a script is executed FOR
// REAL through the tool bridge against the LIVE dev store, so:
//
//   - a read tool proves the bundle's tool is registered, permitted and
//     answering from the real Admin API;
//   - a GATED mutation (`draft_orders_create`, `refunds_create`) proves the
//     kernel stages a real approval instead of executing — nothing is created
//     or refunded on the dev store, because no scenario approves one;
//   - the scripted answer text is the test's own, and is used only to pin the
//     turn ("this row, not an earlier turn's"), never as evidence about Shopify.
//
// Real ids cannot be chained inside a static script (the script is written
// before the turn runs), so a scenario that needs one resolves it out of band
// through `runShopifyTool` and scripts the call with the id it got back.

import { resolve } from "node:path"
import { api, type WorkerEnv } from "@liaison/test-helpers"
import { agentDmThreadId, type ScriptedTurnStep, scriptAgentTurn } from "../agent-turn"
import { bundledAppTarball } from "../bundled-app-tarball"
import { installShopifyApp } from "./helpers/install-shopify-app"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
export const SHOPIFY_BUNDLE = bundledAppTarball(LIAISON_ROOT, "shopify")

/** Install Shopify against the live dev store (real install harness) so
 *  the manifest is registered and the bundled `ui.js` loads in the host. */
export async function installShopifyForAgent(opts: {
  serverUrl: string
  token: string
  orgId: string
  shopDomain: string
  realOfflineToken: string
  realWebhookSecret: string
}): Promise<void> {
  await installShopifyApp({
    serverUrl: opts.serverUrl,
    token: opts.token,
    orgId: opts.orgId,
    shopDomain: opts.shopDomain,
    realOfflineToken: opts.realOfflineToken,
    realWebhookSecret: opts.realWebhookSecret,
    bundlePath: SHOPIFY_BUNDLE,
  })
}

/**
 * One real invocation of a Shopify tool, outside a turn — the way a scenario
 * learns a real id (a customer, an order, a variant) before it can script a
 * call that needs one. Same sandbox RPC bridge the agent's own call goes
 * through, so an id it returns is one the agent's call will accept.
 */
export async function runShopifyTool(
  serverUrl: string,
  token: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<any> {
  const res = await api(serverUrl, "/api/apps/run-tool", {
    token,
    body: { toolName: `shopify:${tool}`, params },
  })
  if (res.status !== 200) {
    throw new Error(`runShopifyTool ${tool}: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return (res.body as { data?: unknown }).data ?? res.body
}

/** One turn: the call (or calls) it makes, then the line it ends with. */
export interface ShopifyAgentTurn {
  calls: Array<{ name: string; args: Record<string, unknown> }>
  /** The turn's closing text — also what `waitForTurnEnd` pins the turn by. */
  text: string
}

/**
 * Script a SEQUENCE of server-side turns in the caller's personal-agent DM and
 * hand back the thread id the scenario then waits on. The script is consumed in
 * order across as many sends as the scenario makes, so `turns.length` sends
 * replay `turns` one per send.
 *
 * TWO REASONS IT IS ONE TOOL PER TURN RATHER THAN ONE CHAIN IN ONE TURN:
 *
 *  1. `shopify__*` tools are app tools, and every app tool is deferred until
 *     `tool_search` loads it (`tool-bridge.ts`). THE LOADED SET IS PER RUN, NOT
 *     PER THREAD (`run-context.ts` holds `discoveredTools`, and
 *     `computeActiveTools()` rebuilds `activeTools` from it at the start of every
 *     turn), so a second turn starts with the app catalog deferred again. A call
 *     to a tool the provider was not shown is not an error either: `blindCallRepair`
 *     (`agent-service.ts`) rewrites it, in the same step, into
 *     `kernel__tool_search select:<name>` — the scripted step is consumed and the
 *     tool never runs. So EVERY turn that calls an app tool opens with its own
 *     `select:` discovery step, not just the first.
 *  2. SCOPE TAINT. In this lane the Shopify bundle is installed from a freshly
 *     built tarball, which is not the image's catalog artifact, so
 *     `firstPartyInstalls()` does not vouch for it and `runtime.ts` therefore
 *     DROPS each tool's `readOnly: true` (it is honoured only for a trusted or
 *     first-party app). Every Shopify tool then looks to `assertNoScopeTaintedWrite`
 *     like a write to an undeclared table, so the SECOND call in a turn — even a
 *     plain search — is refused with `E_SCOPE_TAINT_BLOCKED`
 *     (`writeTargetTable: "undeclared"`) once the first has accumulated a scope.
 *     A turn per call keeps each accumulator clean. See the P4c-T21b-b report:
 *     this is a gap in how `readOnly` survives a non-catalog install, not
 *     something a test should paper over by declaring the tools read-only itself.
 */
export async function scriptShopifyTurns(
  env: WorkerEnv,
  opts: { token: string; turns: ShopifyAgentTurn[] },
): Promise<string> {
  const threadId = await agentDmThreadId(env, opts.token)
  const steps: ScriptedTurnStep[] = []
  for (const turn of opts.turns) {
    // Kernel tools are always loaded; only the app-namespaced ones are deferred,
    // and they are deferred again on every new turn. Selecting them BY NAME (the
    // exact names this turn is about to call) is the one discovery that cannot
    // come back with the wrong tool and leave the scripted call to be repaired
    // away.
    const deferred = turn.calls.map((c) => c.name).filter((name) => !name.startsWith("kernel__"))
    if (deferred.length > 0) {
      steps.push({
        toolCalls: [
          { name: "kernel__tool_search", args: { query: `select:${deferred.join(",")}` } },
        ],
      })
    }
    for (const call of turn.calls) steps.push({ toolCalls: [call] })
    steps.push({ text: turn.text })
  }
  await scriptAgentTurn(env, { threadId, steps })
  return threadId
}
