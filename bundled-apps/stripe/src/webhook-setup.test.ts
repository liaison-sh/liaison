// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Setting up the Stripe webhook: the events an admin selects are the ones the handler acts on
// (in the tool, the settings page and the setup guide alike), the signing secret has one shape
// everywhere, the status says set or not without ever reading the secret, and the settings page
// leaves the secret's field to the kernel's own block.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { HANDLED } from "./dispatch"
import { SIGNING_SECRET_PATTERN, WEBHOOK_EVENTS, webhookStatus } from "./tools/webhook-status"

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
) as {
  connections: {
    stripe: {
      appSecretConfigKeys: string[]
      appSecretFields: Array<{ key: string; pattern: string }>
      setupGuide: { steps: Array<{ text: string }> }
    }
  }
  tools: Record<string, { requiredScopes: string[]; readOnly?: boolean; agentVisible?: boolean }>
  settings: { sections: Array<{ id: string; adminScope?: string; blocks: unknown[] }> }
}
const conn = manifest.connections.stripe
const GOOD = "whsec_abcdefghijklmnop0123456789AB"

function statusCtx(config: Record<string, unknown>, state = "key_stored") {
  const reads: string[] = []
  return {
    reads,
    ctx: {
      orgId: "org-1",
      db: {
        findMany: async () => [{ id: "i1", state }],
        insert: async () => ({ id: "x" }),
        update: async () => {},
      },
      config: {
        has: async (k: string) => typeof config[k] === "string" && config[k] !== "",
        get: async (k: string) => {
          reads.push(k)
          return config[k] ?? null
        },
      },
      fetch: async () => {
        throw new Error("webhook_status calls no API")
      },
    },
  }
}

describe("the events to select", () => {
  it("are exactly the ones the event handler acts on", () => {
    expect([...WEBHOOK_EVENTS]).toEqual(Object.keys(HANDLED).sort())
  })

  it("the setup guide names each of them, and no other event", () => {
    const text = conn.setupGuide.steps.map((s) => s.text).join("\n")
    const named = [...text.matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)].map((m) => m[1])
    expect(named.sort()).toEqual([...WEBHOOK_EVENTS])
  })
})

describe("the signing secret's shape", () => {
  it("is one pattern in the manifest and the tool", () => {
    const field = conn.appSecretFields.find((f) => f.key === "webhookSigningSecret")
    expect(field?.pattern).toBe(SIGNING_SECRET_PATTERN.source)
    // Only the current secret is a person's to set; the previous one is the kernel's roll.
    expect(conn.appSecretFields.map((f) => f.key)).toEqual(["webhookSigningSecret"])
    expect(conn.appSecretConfigKeys).toContain("webhookSigningSecretPrevious")
  })

  it("accepts a whsec secret, refuses a restricted or secret key and a short whsec", () => {
    expect(SIGNING_SECRET_PATTERN.test(GOOD)).toBe(true)
    for (const bad of ["rk_live_abcdefghijklmnop", "sk_test_abcdefghijklmnop", "whsec_short"])
      expect(SIGNING_SECRET_PATTERN.test(bad)).toBe(false)
  })
})

describe("webhook_status", () => {
  it("is an admin read the agent sees, and the settings page has a Webhook section for admins", () => {
    const tool = manifest.tools.webhook_status
    expect(tool?.requiredScopes).toEqual(["stripe:admin:connection"])
    expect(tool?.readOnly).toBe(true)
    expect(tool?.agentVisible).not.toBe(false)
    const section = manifest.settings.sections.find((s) => s.id === "webhook")
    expect(section?.adminScope).toBe("stripe:admin:connection")
    // The kernel draws the secret's field (the app bundle never sends it); the app, its events.
    expect(section?.blocks).toEqual([
      { block: "appSecrets", connection: "stripe" },
      expect.objectContaining({ component: "StripeWebhookSettings" }),
    ])
  })

  it("without a secret: says so, names the path and the events, and asks for a card, never a message", async () => {
    const { ctx, reads } = statusCtx({})
    const out = await webhookStatus({}, ctx)
    expect(out.secretSet).toBe(false)
    expect(out.webhookPath).toBe("/webhooks/org-1/stripe/events")
    expect(out.events).toEqual(WEBHOOK_EVENTS)
    expect(out.state).toBe("key_stored")
    expect(out.next).toContain("kind app_secret")
    expect(out.next).toContain("Never ask for it in a message")
    // The secret is never read, only asked whether it is set.
    expect(reads).not.toContain("webhookSigningSecret")
  })

  it("with a secret and a roll in progress: set, and until when the previous one verifies", async () => {
    const now = new Date("2026-11-26T12:00:00Z")
    const until = "2026-11-27T11:00:00.000Z"
    const { ctx, reads } = statusCtx(
      {
        webhookSigningSecret: "ciphertext",
        webhookSigningSecretPrevious: "old-ciphertext",
        webhookSigningSecretPreviousUntil: until,
      },
      "connected",
    )
    const out = await webhookStatus({}, ctx, now)
    expect(out.secretSet).toBe(true)
    expect(out.previousSecretUntil).toBe(until)
    expect(out.state).toBe("connected")
    expect(JSON.stringify(out)).not.toContain("ciphertext")
    expect(reads).toEqual(["webhookSigningSecretPreviousUntil"])
  })
})
