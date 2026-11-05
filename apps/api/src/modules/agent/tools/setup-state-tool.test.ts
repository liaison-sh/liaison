// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `kernel__setup_state`: the agent reads what is left to set up through a
// deferred tool, never through its prompt. Any member may read it; only an
// administrator is told it can act on it. The result carries the rule that
// sends the agent to the setup-guide skill, and that skill is a deferred
// playbook, not an always-on instruction.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { UserContext } from "~/db/rls"
import { KERNEL_RESULT_HINTS, registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { setupNextAction } from "~/modules/agent/tools/setup-state-tool"
import type { FeaturePlan } from "~/modules/connection-guides/setup-features"

/** A plan whose chosen features leave exactly these connections. */
function plan(refs: string[]): FeaturePlan {
  return {
    chosen: ["email"],
    counted: ["email"],
    done: [],
    left: refs.map((r) => ({ feature: r.split("/")[0] ?? r, refs: [r] })),
    leftMinutes: [0, 0],
    menu: [],
  }
}

import { isDeferredTool } from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { bootstrapAdminThread } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let admin: UserContext
let member: UserContext

type Handler = (params: unknown, ctx: unknown) => Promise<Record<string, unknown>>

function setupStateHandler(): Handler {
  const def = toolRegistry.get([orgId, "kernel", "setup_state"])
  if (!def || typeof def.handler !== "function") throw new Error("setup_state not registered")
  return def.handler as Handler
}

beforeAll(async () => {
  await acquireTestLock()
  const t = await bootstrapAdminThread()
  orgId = t.orgId
  admin = t.actor
  member = t.memberActor
  await registerKernelAgentTools(orgId)
})

afterAll(releaseTestLock)

describe("kernel__setup_state", () => {
  test("is deferred, read-only, with a short description any member may call", () => {
    const def = toolRegistry.get([orgId, "kernel", "setup_state"])
    expect(def).toBeDefined()
    expect(isDeferredTool("kernel", def as { deferLoading?: boolean })).toBe(true)
    expect(def?.readOnly).toBe(true)
    expect(def?.gated).toBeFalsy()
    expect((def?.description ?? "").length).toBeLessThanOrEqual(240)
    expect(def?.requiredScopes).toEqual(["kernel:threads:read"])
  })

  test("an administrator can configure, a member reads only", async () => {
    const asAdmin = await setupStateHandler()({}, { orgId, userId: admin.userId })
    expect(asAdmin.canConfigure).toBe(true)
    expect(Array.isArray(asAdmin.items)).toBe(true)

    const asMember = await setupStateHandler()({}, { orgId, userId: member.userId })
    expect(asMember.canConfigure).toBe(false)
    expect(asMember.items).toEqual(asAdmin.items)
  })

  test("the result sends the agent to the setup-guide skill", async () => {
    expect(KERNEL_RESULT_HINTS.setup_state).toContain("setup-guide")
    const result = await setupStateHandler()({}, { orgId, userId: admin.userId })
    expect(result.hint).toBe(KERNEL_RESULT_HINTS.setup_state)
  })

  test("an app turned on but not connected comes before the checklist's next item, with its exact call", () => {
    const base = {
      items: [],
      next: "mail" as const,
      asOf: "2026-10-27T00:00:00Z",
      features: plan(["shopify/shop", "mail/gmail"]),
    }
    const shopify = setupNextAction({
      ...base,
      connections: [
        {
          app: "shopify",
          connection: "shop",
          client: "none",
          connected: false,
          next: "client_card",
        },
      ],
    })
    expect(shopify).toContain(
      "shopify/shop: read the shopify-setup skill and call kernel__shopify_app_toml",
    )
    expect(shopify).toContain(
      "finish connecting that one first, before the checklist's next item (mail)",
    )
    // Walk N37: the others are optional, never set up unasked, never on a made-up address.
    expect(shopify).toContain("never propose or set one up on your own (a ticket inbox")
    expect(shopify).toContain("never make up an address")
    // Walk N44: a connection nobody asked for is offered as a question, never as a card.
    expect(shopify).toContain(
      "A Connect or secret card is posted only for a connection the person asked for",
    )
    expect(shopify).toContain("as a question, never as a card")
    const gmail = setupNextAction({
      ...base,
      connections: [
        { app: "mail", connection: "gmail", client: "org", connected: false, next: "consent_card" },
      ],
    })
    expect(gmail).toContain("kind oauth_connect, app mail, connection gmail")
    expect(setupNextAction({ ...base, connections: [], features: plan([]) })).toBe(
      "Next checklist item: mail.",
    )
  })

  test("only chosen features are pushed; unchosen ones are a menu; an unanswered question comes first", () => {
    const gitlab = {
      app: "gitlab",
      connection: "gitlab",
      client: "org" as const,
      connected: false,
      next: "consent_card" as const,
    }
    const action = setupNextAction({
      items: [],
      next: null,
      asOf: "2026-10-27T00:00:00Z",
      connections: [gitlab],
      features: {
        ...plan([]),
        chosen: null,
        counted: ["email", "support"],
        menu: [{ feature: "gitlab", label: "GitLab", minutes: [2, 4] }],
      },
    })
    expect(action).toStartWith("First ask which features the person wants")
    expect(action).toContain("kernel__config_setup")
    expect(action).not.toContain("gitlab/gitlab:")
    expect(action).toContain("a menu, offered only when the person asks")
    expect(action).toContain("GitLab (2 to 4 min)")
  })

  test("a chosen feature partly done says what is already connected", () => {
    const action = setupNextAction({
      items: [],
      next: null,
      asOf: "2026-10-27T00:00:00Z",
      connections: [],
      features: {
        ...plan([]),
        left: [
          {
            feature: "social",
            refs: ["social/instagram", "social/instagram_unified"],
            done: ["social/facebook"],
          },
        ],
      },
    })
    expect(action).toContain("Partly done already: social (social/facebook connected)")
    expect(action).toContain("already connected: social/facebook")
  })

  test("a switched-off connection's next action is to turn it on, never the Connect card", () => {
    const action = setupNextAction({
      items: [],
      next: "mail",
      asOf: "2026-10-27T00:00:00Z",
      features: plan(["mail/gmail"]),
      connections: [
        {
          app: "mail",
          connection: "gmail",
          client: "org",
          connected: false,
          next: "turn_on",
          turnOn: "Turn them on first: kernel__config_apps with { apps: [...] }",
        },
      ],
    })
    expect(action).toContain(
      "mail/gmail: turn it on first, it is switched off for the workspace: Turn them on first: kernel__config_apps",
    )
    expect(action).not.toContain("kind oauth_connect")
    expect(action).not.toContain("kernel__google_setup")
  })

  test("the tool result carries the next action", async () => {
    const result = await setupStateHandler()({}, { orgId, userId: admin.userId })
    expect(typeof result.nextAction).toBe("string")
  })

  test("setup-guide is a deferred skill, never an always-on instruction", () => {
    const skill = skillRegistry.get([orgId, "kernel", "setup-guide"])
    expect(skill).toBeDefined()
    expect(skill?.body).toContain("kernel__setup_state")
    expect(skill?.body).toContain("kernel__request_secret")
    expect(agentInstructionsRegistry.get([orgId, "setup-guide"])).toBeUndefined()
  })
})
